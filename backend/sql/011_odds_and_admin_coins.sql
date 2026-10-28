-- Этап 7: коэффициенты у событий + начисление коинов админом. Выполнить целиком в Supabase -> SQL Editor.
--
-- Что добавляется:
--  1. У события появляется режим выплат payout_mode:
--       'pool' — как раньше, тотализатор: весь банк делится между победителями пропорционально ставкам.
--       'odds' — фиксированный коэффициент: выплата = floor(ставка x коэффициент варианта).
--     Старые события остаются в режиме 'pool' (значение по умолчанию).
--  2. ВАЖНО про 'odds': выплаты не ограничены банком события. Если фаворит зашёл,
--     казино (эмиссия) доплачивает разницу; если не зашёл — забирает все проигравшие ставки.
--     Это осознанная математика фиксированных коэффициентов, ответственность за кэф на админе.
--  3. Админ может начислить (или списать) коины конкретному игроку:
--     функция admin_grant_coins — одна транзакция, запись в ledger + журнал admin_grants.

-- ---------- 1. Режим выплат и коэффициенты ----------

alter table events add column if not exists payout_mode text not null default 'pool';
alter table events drop constraint if exists events_payout_mode_check;
alter table events add constraint events_payout_mode_check check (payout_mode in ('pool', 'odds'));

-- Коэффициент варианта. null = режим пула (кэф считается динамически из банка).
alter table event_options add column if not exists odds numeric(7, 2);
alter table event_options drop constraint if exists event_options_odds_check;
alter table event_options add constraint event_options_odds_check
  check (odds is null or (odds >= 1.01 and odds <= 1000));

-- Создание события: p_mode = 'pool' (как раньше) или 'odds' с массивом коэффициентов p_odds.
-- Старая 4-аргументная версия удаляется, иначе вызов с 4 аргументами станет неоднозначным.
drop function if exists admin_create_event(text, text, timestamptz, text[]);

create or replace function admin_create_event(
  p_title text,
  p_description text,
  p_deadline timestamptz,
  p_options text[],
  p_mode text default 'pool',
  p_odds numeric[] default null
) returns bigint
language plpgsql security definer set search_path = public
as $$
declare
  v_title text := btrim(coalesce(p_title, ''));
  v_desc  text := nullif(btrim(coalesce(p_description, '')), '');
  v_mode  text := coalesce(nullif(btrim(coalesce(p_mode, '')), ''), 'pool');
  v_opt   text;
  v_clean text[] := '{}';
  v_count int;
  v_odd   numeric;
  v_id    bigint;
  v_pos   int := 0;
begin
  if char_length(v_title) < 3 or char_length(v_title) > 200 then raise exception 'bad_title'; end if;
  if v_desc is not null and char_length(v_desc) > 1000 then raise exception 'bad_title'; end if;
  if p_deadline is null or p_deadline <= now() then raise exception 'bad_deadline'; end if;
  if v_mode not in ('pool', 'odds') then raise exception 'bad_mode'; end if;

  foreach v_opt in array coalesce(p_options, '{}'::text[]) loop
    v_opt := btrim(coalesce(v_opt, ''));
    if char_length(v_opt) < 1 or char_length(v_opt) > 100 then raise exception 'bad_options'; end if;
    v_clean := v_clean || v_opt;
  end loop;

  v_count := coalesce(array_length(v_clean, 1), 0);
  if v_count < 2 or v_count > 10 then raise exception 'bad_options'; end if;
  if (select count(distinct lower(x)) from unnest(v_clean) as x) <> v_count then
    raise exception 'bad_options';  -- повторяющиеся варианты
  end if;

  -- Коэффициенты нужны ровно по одному на вариант и только в режиме 'odds'.
  if v_mode = 'odds' then
    if coalesce(array_length(p_odds, 1), 0) <> v_count then raise exception 'bad_odds'; end if;
    foreach v_odd in array p_odds loop
      if v_odd is null or v_odd < 1.01 or v_odd > 1000 then raise exception 'bad_odds'; end if;
    end loop;
  end if;

  insert into events (title, description, deadline, payout_mode)
  values (v_title, v_desc, p_deadline, v_mode)
  returning id into v_id;

  foreach v_opt in array v_clean loop
    v_pos := v_pos + 1;
    insert into event_options (event_id, title, position, odds)
    values (v_id, v_opt, v_pos, case when v_mode = 'odds' then round(p_odds[v_pos], 2) else null end);
  end loop;

  return v_id;
end;
$$;

-- ---------- 2. Закрытие события с учётом режима выплат ----------
--
-- Режим 'pool' (без изменений):
--   * на победителя ставили: выплата = ставка / сумма ставок победителей x весь банк (остаток
--     от округления раздаётся по монете, итог ровно равен банку);
--   * на победителя не ставили или отмена: возврат ставок.
-- Режим 'odds':
--   * выплата победителям = floor(ставка x коэффициент их варианта), проигравшим 0;
--   * на победителя никто не ставил: выплат нет, банк остаётся казино (возврата НЕТ);
--   * отмена события (p_option = null) — возврат ставок, как и в режиме пула.
-- Повторный вызов ничего не меняет (changed = false).
create or replace function admin_resolve_event(p_event bigint, p_option bigint)
returns table (res_changed boolean, res_status text, res_refunded boolean, res_total bigint, res_paid bigint)
language plpgsql security definer set search_path = public
as $$
declare
  v_status     text;
  v_mode       text;
  v_refunded   boolean;
  v_total      bigint;
  v_free_total bigint;
  v_win_total  bigint := 0;
  v_refund     boolean;
  v_expected   bigint;
  v_paid       bigint;
begin
  -- Порядок блокировок: событие -> игроки (по возрастанию id). Как и в place_bet: сначала событие.
  select e.status, e.refunded, e.payout_mode into v_status, v_refunded, v_mode
  from events e where e.id = p_event for update;
  if not found then raise exception 'event_not_found'; end if;

  select coalesce(sum(b.amount), 0), coalesce(sum(b.free_amount), 0) into v_total, v_free_total
  from bets b where b.event_id = p_event;

  if v_status <> 'open' then
    res_changed := false; res_status := v_status; res_refunded := v_refunded; res_total := v_total;
    select coalesce(sum(b.payout), 0) into res_paid from bets b where b.event_id = p_event;
    return next;
    return;
  end if;

  if p_option is not null and not exists (
    select 1 from event_options o where o.id = p_option and o.event_id = p_event
  ) then
    raise exception 'bad_option';
  end if;

  if p_option is not null then
    select coalesce(sum(b.amount), 0) into v_win_total
    from bets b where b.event_id = p_event and b.option_id = p_option;
  end if;

  -- Возврат: при отмене всегда; в режиме пула ещё и когда на победителя никто не ставил
  -- (банк просто некому делить). В режиме кэфов проигравшие ставки остаются казино.
  v_refund := p_option is null or (v_mode = 'pool' and v_win_total = 0);

  if v_refund then
    -- Возврат: игроку возвращаются только его настоящие монеты. Бесплатная часть возвращается токеном.
    update bets set payout = amount - free_amount where event_id = p_event;
    perform 1 from users u where u.id in (select b.user_id from bets b where b.event_id = p_event and b.payout > 0)
      order by u.id for update;
    with upd as (
      update users u set balance = u.balance + b.payout
      from bets b where b.event_id = p_event and b.user_id = u.id and b.payout > 0
      returning u.id as uid, b.payout as amt, u.balance as bal
    )
    insert into ledger (user_id, amount, balance_after, reason)
    select uid, amt, bal, 'bet_refund' from upd;

    update free_bets set status = 'available', used_at = null, used_event_id = null
    where used_event_id = p_event and status = 'used';

    v_expected := v_total - v_free_total;

  elsif v_mode = 'odds' then
    -- Без кэфа у варианта считать нечего: лучше отказ, чем выплаты с null.
    if not exists (select 1 from event_options o where o.id = p_option and o.odds is not null) then
      raise exception 'bad_odds';
    end if;

    -- Фиксированный коэффициент: выплата зависит только от ставки игрока и кэфа варианта.
    update bets b
       set payout = floor(b.amount::numeric * o.odds)::bigint
      from event_options o
     where b.event_id = p_event and b.option_id = p_option and o.id = p_option;

    update bets set payout = 0 where event_id = p_event and option_id <> p_option;

    select coalesce(sum(b.payout), 0) into v_expected
    from bets b where b.event_id = p_event and b.option_id = p_option;

    perform 1 from users u where u.id in (select b.user_id from bets b where b.event_id = p_event and b.payout > 0)
      order by u.id for update;
    with upd as (
      update users u set balance = u.balance + b.payout
      from bets b where b.event_id = p_event and b.user_id = u.id and b.payout > 0
      returning u.id as uid, b.payout as amt, u.balance as bal
    )
    insert into ledger (user_id, amount, balance_after, reason)
    select uid, amt, bal, 'bet_win' from upd;

  else
    with w as (
      select b.id,
             floor(b.amount::numeric * v_total / v_win_total) as base,
             (b.amount::numeric * v_total) % v_win_total      as rem
      from bets b where b.event_id = p_event and b.option_id = p_option
    ), r as (
      select w.id, w.base,
             row_number() over (order by w.rem desc, w.id) as rn,
             v_total - sum(w.base) over ()                 as leftover
      from w
    )
    update bets b
       set payout = (r.base + case when r.rn <= r.leftover then 1 else 0 end)::bigint
      from r where b.id = r.id;

    update bets set payout = 0 where event_id = p_event and option_id <> p_option;

    perform 1 from users u where u.id in (select b.user_id from bets b where b.event_id = p_event and b.payout > 0)
      order by u.id for update;
    with upd as (
      update users u set balance = u.balance + b.payout
      from bets b where b.event_id = p_event and b.user_id = u.id and b.payout > 0
      returning u.id as uid, b.payout as amt, u.balance as bal
    )
    insert into ledger (user_id, amount, balance_after, reason)
    select uid, amt, bal, 'bet_win' from upd;

    v_expected := v_total;
  end if;

  -- Страховка: выплачено ровно положенное, иначе вся операция откатывается.
  select coalesce(sum(b.payout), 0) into v_paid from bets b where b.event_id = p_event;
  if v_paid <> v_expected then raise exception 'payout_mismatch'; end if;

  update events
     set status = case when p_option is null then 'cancelled' else 'resolved' end,
         winning_option_id = p_option,
         refunded = v_refund,
         resolved_at = now()
   where id = p_event;

  res_changed := true;
  res_status := case when p_option is null then 'cancelled' else 'resolved' end;
  res_refunded := v_refund;
  res_total := v_total;
  res_paid := v_paid;
  return next;
end;
$$;

-- ---------- 3. Начисление коинов админом ----------

-- Журнал ручных начислений: кто, кому, сколько и за что. Отдельно от ledger, чтобы было видно автора.
create table if not exists admin_grants (
  id            bigint generated always as identity primary key,
  admin_id      bigint not null references users(id),
  user_id       bigint not null references users(id),
  amount        bigint not null check (amount <> 0),   -- + начисление, - списание
  reason        text,
  balance_after bigint not null,
  created_at    timestamptz not null default now()
);
create index if not exists admin_grants_created_idx on admin_grants (created_at desc);
alter table admin_grants enable row level security;

-- Начислить (p_amount > 0) или списать (p_amount < 0) коины игроку. Одна транзакция.
-- Списать больше, чем есть на руках, нельзя: баланс не уходит в минус (insufficient_funds).
create or replace function admin_grant_coins(
  p_admin bigint, p_user bigint, p_amount bigint, p_reason text default null
) returns table (new_balance bigint, grant_id bigint)
language plpgsql security definer set search_path = public
as $$
declare
  c_max_amount constant bigint := 1000000000000;
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
  v_balance bigint;
  v_id      bigint;
begin
  if p_amount is null or p_amount = 0 or abs(p_amount) > c_max_amount then raise exception 'bad_amount'; end if;
  if v_reason is not null and char_length(v_reason) > 200 then raise exception 'bad_reason'; end if;

  perform 1 from users u where u.id = p_admin;
  if not found then raise exception 'admin_not_found'; end if;

  select u.balance into v_balance from users u where u.id = p_user for update;
  if not found then raise exception 'user_not_found'; end if;
  if v_balance + p_amount < 0 then raise exception 'insufficient_funds'; end if;

  v_balance := v_balance + p_amount;
  update users set balance = v_balance where id = p_user;

  insert into ledger (user_id, amount, balance_after, reason)
  values (p_user, p_amount, v_balance, case when p_amount > 0 then 'admin_grant' else 'admin_deduct' end);

  insert into admin_grants (admin_id, user_id, amount, reason, balance_after)
  values (p_admin, p_user, p_amount, v_reason, v_balance)
  returning id into v_id;

  new_balance := v_balance;
  grant_id := v_id;
  return next;
end;
$$;

-- ---------- Права: вызывать функции может только наш бэкенд (service_role) ----------
revoke all on function admin_create_event(text, text, timestamptz, text[], text, numeric[]) from public, anon, authenticated;
revoke all on function admin_resolve_event(bigint, bigint) from public, anon, authenticated;
revoke all on function admin_grant_coins(bigint, bigint, bigint, text) from public, anon, authenticated;
grant execute on function
  admin_create_event(text, text, timestamptz, text[], text, numeric[]),
  admin_resolve_event(bigint, bigint),
  admin_grant_coins(bigint, bigint, bigint, text)
to service_role;

notify pgrst, 'reload schema';
