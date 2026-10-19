-- Этап 5a: колесо фортуны (призы-монеты, бесплатный спин раз в сутки UTC, докупка спинов).
-- Выполнить в Supabase -> SQL Editor.

create table if not exists prizes (
  id     bigint generated always as identity primary key,
  kind   text   not null check (kind in ('coins', 'free_bet', 'steal', 'part')),
  value  bigint not null default 0 check (value >= 0),
  weight int    not null check (weight > 0),          -- чем больше, тем чаще выпадает
  label  text   not null check (char_length(label) between 1 and 40),
  sort   int    not null default 0,                   -- порядок секторов на колесе
  active boolean not null default true,
  check (kind <> 'coins' or value > 0)
);
alter table prizes enable row level security;

create table if not exists spins (
  id         bigint generated always as identity primary key,
  user_id    bigint not null references users(id),
  prize_id   bigint not null references prizes(id),
  kind       text   not null,
  value      bigint not null,
  paid       boolean not null,                        -- false: бесплатный дневной, true: купленный
  spin_day   date   not null,                         -- день по UTC
  created_at timestamptz not null default now()
);
create index if not exists spins_user_day_idx on spins (user_id, spin_day);
-- На уровне БД: не больше одного бесплатного спина в сутки на игрока.
create unique index if not exists spins_free_daily_uidx on spins (user_id, spin_day) where not paid;
alter table spins enable row level security;

-- Стартовые призы (только если таблица пустая). Подбор значений: ожидаемый приз ≈ 113 монет.
insert into prizes (kind, value, weight, label, sort)
select 'coins', v, w, v::text, s
from (values (20, 35, 1), (50, 25, 2), (100, 20, 3), (200, 12, 4), (500, 6, 5), (1000, 2, 6)) as t(v, w, s)
where not exists (select 1 from prizes);

-- Параметры (меняются в одном месте)
create or replace function wheel_price() returns bigint language sql immutable as $$ select 150::bigint $$;
create or replace function wheel_max_paid() returns int language sql immutable as $$ select 5 $$;

-- Взвешенный случайный выбор приза. Случайность из криптостойкого gen_random_uuid().
create or replace function wheel_pick_prize() returns bigint
language sql volatile as $$
  with r as (
    select (('x' || substr(gen_random_uuid()::text, 1, 8))::bit(32)::bigint)::numeric / 4294967296 as u
  ), p as (
    select id, sum(weight) over (order by sort, id) as cum, sum(weight) over () as total
    from prizes where active
  )
  select p.id from p, r where p.cum > r.u * p.total order by p.cum limit 1
$$;

create or replace function wheel_state(p_user bigint)
returns table (free_available boolean, paid_today int, paid_max int, price bigint, seconds_to_reset int)
language plpgsql security definer set search_path = public
as $$
declare
  v_day date := (clock_timestamp() at time zone 'utc')::date;
begin
  perform 1 from users u where u.id = p_user;
  if not found then raise exception 'user_not_found'; end if;

  free_available := not exists (select 1 from spins s where s.user_id = p_user and s.spin_day = v_day and not s.paid);
  select count(*)::int into paid_today from spins s where s.user_id = p_user and s.spin_day = v_day and s.paid;
  paid_max := wheel_max_paid();
  price := wheel_price();
  seconds_to_reset := floor(extract(epoch from ((v_day + 1)::timestamp - (clock_timestamp() at time zone 'utc'))))::int;
  return next;
end;
$$;

-- Один спин: 'free' (раз в сутки) или 'paid' (за монеты). Всё в одной транзакции.
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

  -- Блокировка игрока: два одновременных спина выстроятся в очередь
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

  -- Другие типы призов подключаются на следующих шагах. Пока их выдача запрещена (транзакция откатится).
  if v_prize.kind <> 'coins' then raise exception 'prize_not_supported'; end if;

  v_balance := v_balance + v_prize.value;
  update users set balance = v_balance where id = p_user;
  insert into ledger (user_id, amount, balance_after, reason) values (p_user, v_prize.value, v_balance, 'spin_prize');

  insert into spins (user_id, prize_id, kind, value, paid, spin_day)
  values (p_user, v_prize.id, v_prize.kind, v_prize.value, p_mode = 'paid', v_day);

  prize_id := v_prize.id; prize_label := v_prize.label; prize_kind := v_prize.kind;
  prize_value := v_prize.value; new_balance := v_balance; was_free := p_mode = 'free';
  return next;
end;
$$;

revoke all on function wheel_price(), wheel_max_paid(), wheel_pick_prize() from public, anon, authenticated;
revoke all on function wheel_state(bigint), wheel_spin(bigint, text) from public, anon, authenticated;
grant execute on function wheel_state(bigint), wheel_spin(bigint, text) to service_role;

notify pgrst, 'reload schema';
