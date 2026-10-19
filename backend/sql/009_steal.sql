-- Этап 5c: воровство монет через колесо фортуны. Выполнить в Supabase -> SQL Editor.
--
-- Правила (все числа в функциях-константах ниже):
--  * жертва выбирается случайно среди игроков: не сам вор, аккаунт старше 24 часов,
--    монет в КОШЕЛЬКЕ больше 100, у жертвы за последние 24 часа украли не больше 2 раз (лимит 3);
--  * крадётся от 5% до 10% кошелька жертвы, но не больше 500 монет;
--  * сберегательный счёт (savings) не затрагивается;
--  * если подходящей жертвы нет, колесо выдаёт другой приз (кроме кражи);
--  * строки жертвы блокируются с SKIP LOCKED: если жертва занята другой операцией, берётся другая.

create table if not exists steals (
  id         bigint generated always as identity primary key,
  thief_id   bigint not null references users(id),
  victim_id  bigint not null references users(id),
  amount     bigint not null check (amount > 0),
  spin_id    bigint references spins(id),
  seen       boolean not null default false,       -- жертва уже увидела уведомление
  created_at timestamptz not null default now(),
  check (thief_id <> victim_id)
);
create index if not exists steals_victim_idx on steals (victim_id, created_at desc);
create index if not exists steals_unseen_idx on steals (victim_id) where not seen;
alter table steals enable row level security;

-- Параметры воровства
create or replace function steal_min_balance()   returns bigint  language sql immutable as $$ select 100::bigint $$;  -- баланс жертвы строго больше
create or replace function steal_newbie_hours()  returns int     language sql immutable as $$ select 24 $$;
create or replace function steal_pct_min()       returns numeric language sql immutable as $$ select 5::numeric $$;
create or replace function steal_pct_max()       returns numeric language sql immutable as $$ select 10::numeric $$;
create or replace function steal_cap()           returns bigint  language sql immutable as $$ select 500::bigint $$;
create or replace function steal_victim_cap()    returns int     language sql immutable as $$ select 3 $$;              -- краж у одной жертвы за 24 часа

-- Случайное число [0, 1) из криптостойкого источника
create or replace function rand01() returns numeric language sql volatile as $$
  select (('x' || substr(gen_random_uuid()::text, 1, 8))::bit(32)::bigint)::numeric / 4294967296
$$;

-- Выбор приза: теперь можно исключить кражу (когда нет подходящей жертвы)
drop function if exists wheel_pick_prize();
create or replace function wheel_pick_prize(p_allow_steal boolean default true) returns bigint
language sql volatile as $$
  with r as (select rand01() as u), p as (
    select id, sum(weight) over (order by sort, id) as cum, sum(weight) over () as total
    from prizes where active and (p_allow_steal or kind <> 'steal')
  )
  select p.id from p, r where p.cum > r.u * p.total order by p.cum limit 1
$$;

-- Приз-кража в стартовом наборе (один раз)
insert into prizes (kind, value, weight, label, sort)
select 'steal', 0, 6, 'Кража', 9
where not exists (select 1 from prizes where kind = 'steal');

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
  v_victim  bigint;
  v_vbal    bigint;
  v_amount  bigint := 0;
  v_spin    bigint;
begin
  if p_mode is null or p_mode not in ('free', 'paid') then raise exception 'bad_mode'; end if;

  -- Сначала всегда блокируем вора (как и раньше), жертву берём позже и только через SKIP LOCKED:
  -- ожидания нет, поэтому взаимных блокировок между двумя ворующими игроками быть не может.
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

  if v_prize.kind = 'steal' then
    select u.id, u.balance into v_victim, v_vbal
    from users u
    where u.id <> p_user
      and u.created_at <= clock_timestamp() - make_interval(hours => steal_newbie_hours())
      and u.balance > steal_min_balance()
      and (select count(*) from steals s
           where s.victim_id = u.id and s.created_at > clock_timestamp() - interval '24 hours') < steal_victim_cap()
    order by gen_random_uuid()
    limit 1
    for update of u skip locked;

    if v_victim is null then
      -- Подходящей жертвы нет: крутим заново без кражи
      v_pick := wheel_pick_prize(false);
      if v_pick is null then raise exception 'no_prizes'; end if;
      select * into v_prize from prizes where id = v_pick;
    else
      v_amount := least(
        steal_cap(),
        greatest(1, floor(v_vbal * (steal_pct_min() + (steal_pct_max() - steal_pct_min()) * rand01()) / 100))
      )::bigint;

      update users set balance = balance - v_amount where id = v_victim;
      insert into ledger (user_id, amount, balance_after, reason) values (v_victim, -v_amount, v_vbal - v_amount, 'stolen');

      v_balance := v_balance + v_amount;
      update users set balance = v_balance where id = p_user;
      insert into ledger (user_id, amount, balance_after, reason) values (p_user, v_amount, v_balance, 'steal');
    end if;
  end if;

  if v_prize.kind = 'coins' then
    v_balance := v_balance + v_prize.value;
    update users set balance = v_balance where id = p_user;
    insert into ledger (user_id, amount, balance_after, reason) values (p_user, v_prize.value, v_balance, 'spin_prize');
  elsif v_prize.kind = 'free_bet' then
    insert into free_bets (user_id, amount, source) values (p_user, v_prize.value, 'wheel');
  elsif v_prize.kind = 'steal' then
    null;  -- уже выполнено выше
  else
    raise exception 'prize_not_supported';
  end if;

  insert into spins (user_id, prize_id, kind, value, paid, spin_day)
  values (p_user, v_prize.id, v_prize.kind, case when v_prize.kind = 'steal' then v_amount else v_prize.value end,
          p_mode = 'paid', v_day)
  returning id into v_spin;

  if v_prize.kind = 'steal' then
    insert into steals (thief_id, victim_id, amount, spin_id) values (p_user, v_victim, v_amount, v_spin);
  end if;

  prize_id := v_prize.id; prize_label := v_prize.label; prize_kind := v_prize.kind;
  prize_value := case when v_prize.kind = 'steal' then v_amount else v_prize.value end;
  new_balance := v_balance; was_free := p_mode = 'free';
  return next;
end;
$$;

revoke all on function steal_min_balance(), steal_newbie_hours(), steal_pct_min(), steal_pct_max(),
  steal_cap(), steal_victim_cap(), rand01(), wheel_pick_prize(boolean) from public, anon, authenticated;
revoke all on function wheel_spin(bigint, text) from public, anon, authenticated;
grant execute on function wheel_spin(bigint, text) to service_role;

notify pgrst, 'reload schema';
