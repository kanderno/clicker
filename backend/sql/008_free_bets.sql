-- Этап 5b: бесплатные ставки (free bets). Выполнить в Supabase -> SQL Editor.
--
-- Правила:
--  * Бесплатная ставка ("токен") даёт X монет в пул события за счёт казино: у игрока монеты НЕ списываются.
--  * Выигрыш считается как обычно и выплачивается целиком (включая долю бесплатной части).
--  * При отмене события или возврате ставок монеты за бесплатную часть НЕ выдаются,
--    вместо этого токен возвращается игроку и его можно использовать снова.

alter table bets add column if not exists free_amount bigint not null default 0;
alter table bets drop constraint if exists bets_free_amount_check;
alter table bets add constraint bets_free_amount_check check (free_amount >= 0 and free_amount <= amount);

create table if not exists free_bets (
  id            bigint generated always as identity primary key,
  user_id       bigint not null references users(id),
  amount        bigint not null check (amount > 0),
  source        text   not null default 'wheel',
  status        text   not null default 'available' check (status in ('available', 'used')),
  used_event_id bigint references events(id),
  created_at    timestamptz not null default now(),
  used_at       timestamptz
);
create index if not exists free_bets_user_avail_idx on free_bets (user_id) where status = 'available';
alter table free_bets enable row level security;

alter table prizes drop constraint if exists prizes_free_bet_value;
alter table prizes add constraint prizes_free_bet_value check (kind <> 'free_bet' or value > 0);

-- Призы-бесплатные ставки на колесе (добавляются один раз)
insert into prizes (kind, value, weight, label, sort)
select 'free_bet', v, w, 'Free ' || v, s
from (values (100, 8, 7), (300, 3, 8)) as t(v, w, s)
where not exists (select 1 from prizes where kind = 'free_bet');

-- Колесо: теперь умеет выдавать free_bet (остальные типы пока запрещены)
create or replace function wheel_spin(p_user bigint, p_mode text)
returns table (prize_id bigint, prize_label text, prize_kind text, prize_value bigint, new_balance bigint, was_free boolean)
language plpgsql security definer set search_path = public
as $$
declare
  v_day     date := (clock_timestamp() at time zone 'utc')::date;
  v_balance bigint;
  v_paid    int;
  v_prize   prizes%rowtype;
  v_pick    bigint;
begin
  if p_mode is null or p_mode not in ('free', 'paid') then raise exception 'bad_mode'; end if;

  select u.balance into v_balance from users u where u.id = p_user for update;
  if not found then raise exception 'user_not_found'; end if;

  if p_mode = 'free' then
    if exists (select 1 from spins s where s.user_id = p_user and s.spin_day = v_day and not s.paid) then
      raise exception 'free_spin_used';
    end if;
  else
    select count(*)::int into v_paid from spins s where s.user_id = p_user and s.spin_day = v_day and s.paid;
    if v_paid >= wheel_max_paid() then raise exception 'paid_limit'; end if;
    if v_balance < wheel_price() then raise exception 'insufficient_funds'; end if;
    v_balance := v_balance - wheel_price();
    update users set balance = v_balance where id = p_user;
    insert into ledger (user_id, amount, balance_after, reason) values (p_user, -wheel_price(), v_balance, 'spin_buy');
  end if;

  v_pick := wheel_pick_prize();
  if v_pick is null then raise exception 'no_prizes'; end if;
  select * into v_prize from prizes where id = v_pick;

  if v_prize.kind = 'coins' then
    v_balance := v_balance + v_prize.value;
    update users set balance = v_balance where id = p_user;
    insert into ledger (user_id, amount, balance_after, reason) values (p_user, v_prize.value, v_balance, 'spin_prize');
  elsif v_prize.kind = 'free_bet' then
    insert into free_bets (user_id, amount, source) values (p_user, v_prize.value, 'wheel');
  else
    raise exception 'prize_not_supported';
  end if;

  insert into spins (user_id, prize_id, kind, value, paid, spin_day)
  values (p_user, v_prize.id, v_prize.kind, v_prize.value, p_mode = 'paid', v_day);

  prize_id := v_prize.id; prize_label := v_prize.label; prize_kind := v_prize.kind;
  prize_value := v_prize.value; new_balance := v_balance; was_free := p_mode = 'free';
  return next;
end;
$$;

-- Поставить бесплатную ставку (токен) на вариант события.
create or replace function place_free_bet(p_user bigint, p_event bigint, p_option bigint, p_free_bet bigint)
returns table (my_stake bigint, option_pool bigint, my_free bigint)
language plpgsql security definer set search_path = public
as $$
declare
  v_status   text;
  v_deadline timestamptz;
  v_amount   bigint;
  v_fb_state text;
  v_cur_opt  bigint;
  v_cur_amt  bigint;
  v_cur_free bigint;
  v_stake    bigint;
  v_free     bigint;
  v_pool     bigint;
begin
  -- Порядок блокировок как в place_bet: событие -> игрок -> токен -> ставка -> вариант
  select e.status, e.deadline into v_status, v_deadline from events e where e.id = p_event for share;
  if not found then raise exception 'event_not_found'; end if;
  if v_status <> 'open' or clock_timestamp() >= v_deadline then raise exception 'event_closed'; end if;

  if not exists (select 1 from event_options o where o.id = p_option and o.event_id = p_event) then
    raise exception 'bad_option';
  end if;

  perform 1 from users u where u.id = p_user for update;
  if not found then raise exception 'user_not_found'; end if;

  -- токен должен принадлежать игроку и быть свободным (чужой токен выглядит как "не найден")
  select f.amount, f.status into v_amount, v_fb_state
  from free_bets f where f.id = p_free_bet and f.user_id = p_user for update;
  if not found or v_fb_state <> 'available' then raise exception 'free_bet_unavailable'; end if;

  select b.option_id, b.amount, b.free_amount into v_cur_opt, v_cur_amt, v_cur_free
  from bets b where b.user_id = p_user and b.event_id = p_event for update;

  if found then
    if v_cur_opt <> p_option then raise exception 'other_option'; end if;
    v_stake := v_cur_amt + v_amount;
    v_free  := v_cur_free + v_amount;
    update bets set amount = v_stake, free_amount = v_free where user_id = p_user and event_id = p_event;
  else
    v_stake := v_amount;
    v_free  := v_amount;
    insert into bets (user_id, event_id, option_id, amount, free_amount)
    values (p_user, p_event, p_option, v_amount, v_amount);
  end if;

  update free_bets set status = 'used', used_at = now(), used_event_id = p_event where id = p_free_bet;
  update event_options set pool = pool + v_amount where id = p_option returning pool into v_pool;

  my_stake := v_stake; option_pool := v_pool; my_free := v_free;
  return next;
end;
$$;

-- Закрытие события (обновлено под free bets; для обычных ставок поведение прежнее).
create or replace function admin_resolve_event(p_event bigint, p_option bigint)
returns table (res_changed boolean, res_status text, res_refunded boolean, res_total bigint, res_paid bigint)
language plpgsql security definer set search_path = public
as $$
declare
  v_status     text;
  v_refunded   boolean;
  v_total      bigint;
  v_free_total bigint;
  v_win_total  bigint := 0;
  v_refund     boolean;
  v_expected   bigint;
  v_paid       bigint;
begin
  select e.status, e.refunded into v_status, v_refunded from events e where e.id = p_event for update;
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

  v_refund := p_option is null or v_win_total = 0;

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

revoke all on function wheel_spin(bigint, text) from public, anon, authenticated;
revoke all on function place_free_bet(bigint, bigint, bigint, bigint) from public, anon, authenticated;
revoke all on function admin_resolve_event(bigint, bigint) from public, anon, authenticated;
grant execute on function wheel_spin(bigint, text), place_free_bet(bigint, bigint, bigint, bigint), admin_resolve_event(bigint, bigint) to service_role;

notify pgrst, 'reload schema';
