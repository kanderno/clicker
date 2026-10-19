-- Этап 6: майнеры (детали, сборка, улучшение, пассивный доход). Выполнить в Supabase -> SQL Editor.
--
-- Правила:
--  * Детали (болт, чип, ядро) выпадают на колесе или покупаются за монеты в магазине.
--  * Майнер собирается из деталей по рецепту (все детали списываются разом).
--  * Доход при чтении: ставка в час x min(часов с последнего сбора, 2). Никаких cron-задач.
--  * Улучшение сначала выплачивает накопленный доход по СТАРОЙ ставке, потом поднимает уровень.
--  * Все числа (цены, ставки, лимиты) лежат в таблицах и функциях-константах ниже.

create table if not exists part_types (
  id         bigint generated always as identity primary key,
  code       text   not null unique,
  name       text   not null,
  shop_price bigint not null check (shop_price > 0),
  sort       int    not null default 0
);

create table if not exists miner_types (
  id           bigint generated always as identity primary key,
  code         text   not null unique,
  name         text   not null,
  base_income  bigint not null check (base_income > 0),     -- монет в час на 1 уровне
  upgrade_base bigint not null check (upgrade_base > 0),    -- цена улучшения 1 -> 2 уровень
  max_level    int    not null check (max_level >= 1),
  sort         int    not null default 0,
  active       boolean not null default true
);

create table if not exists miner_recipes (
  miner_type_id bigint not null references miner_types(id) on delete cascade,
  part_type_id  bigint not null references part_types(id),
  qty           int    not null check (qty > 0),
  primary key (miner_type_id, part_type_id)
);

create table if not exists parts_inventory (
  user_id      bigint not null references users(id),
  part_type_id bigint not null references part_types(id),
  qty          bigint not null default 0 check (qty >= 0),
  primary key (user_id, part_type_id)
);

create table if not exists user_miners (
  id                bigint generated always as identity primary key,
  user_id           bigint not null references users(id),
  miner_type_id     bigint not null references miner_types(id),
  level             int    not null default 1 check (level >= 1),
  built_at          timestamptz not null default now(),
  last_collected_at timestamptz not null default now()
);
create index if not exists user_miners_user_idx on user_miners (user_id);

alter table part_types      enable row level security;
alter table miner_types     enable row level security;
alter table miner_recipes   enable row level security;
alter table parts_inventory enable row level security;
alter table user_miners     enable row level security;

-- Стартовые данные (повторный запуск ничего не дублирует)
insert into part_types (code, name, shop_price, sort) values
  ('bolt', 'Болт', 60, 1), ('chip', 'Чип', 180, 2), ('core', 'Ядро', 500, 3)
on conflict (code) do nothing;

insert into miner_types (code, name, base_income, upgrade_base, max_level, sort) values
  ('mini',    'Мини-майнер', 20,  150,  5, 1),
  ('factory', 'Фабрика',     90,  800,  8, 2),
  ('farm',    'Ферма',       300, 3000, 10, 3)
on conflict (code) do nothing;

insert into miner_recipes (miner_type_id, part_type_id, qty)
select m.id, p.id, r.qty
from (values ('mini','bolt',3), ('mini','chip',1),
             ('factory','bolt',6), ('factory','chip',3), ('factory','core',1),
             ('farm','bolt',10), ('farm','chip',6), ('farm','core',3)) as r(mc, pc, qty)
join miner_types m on m.code = r.mc
join part_types  p on p.code = r.pc
on conflict do nothing;

-- Призы-детали на колесе
alter table prizes add column if not exists part_type_id bigint references part_types(id);
alter table prizes drop constraint if exists prizes_part_check;
alter table prizes add constraint prizes_part_check check (kind <> 'part' or (part_type_id is not null and value > 0));

insert into prizes (kind, value, weight, label, sort, part_type_id)
select 'part', t.qty, t.w, p.name || ' x' || t.qty, t.s, p.id
from (values ('bolt', 2, 10, 10), ('chip', 1, 6, 11), ('core', 1, 2, 12)) as t(pc, qty, w, s)
join part_types p on p.code = t.pc
where not exists (select 1 from prizes where kind = 'part');

-- ---------- параметры и формулы ----------
create or replace function miners_max_per_user() returns int language sql immutable as $$ select 10 $$;
create or replace function miners_cap_hours()    returns int language sql immutable as $$ select 2 $$;   -- накопление не дольше 2 часов

-- доход в час на уровне L: base * (L + 1) / 2  (1 ур: base, 2 ур: 1.5x, 3 ур: 2x ...)
create or replace function miner_rate(p_base bigint, p_level int) returns bigint
language sql immutable as $$ select floor(p_base * (p_level + 1) / 2.0)::bigint $$;

-- цена улучшения с уровня L на L+1: base * 1.7^(L-1)
create or replace function miner_upgrade_cost(p_base bigint, p_level int) returns bigint
language sql immutable as $$ select floor(p_base * power(1.7::numeric, (p_level - 1)))::bigint $$;

-- накопленный доход: ставка * min(часы с последнего сбора, лимит)
create or replace function miner_pending(p_rate bigint, p_last timestamptz, p_now timestamptz) returns bigint
language sql stable as $$
  select floor(p_rate * least(greatest(extract(epoch from (p_now - p_last))::numeric, 0), miners_cap_hours() * 3600) / 3600.0)::bigint
$$;

create or replace function miners_config() returns table (max_miners int, cap_hours int)
language sql stable as $$ select miners_max_per_user(), miners_cap_hours() $$;

-- Состояние майнеров игрока (только чтение; те же формулы, что при сборе)
create or replace function miners_overview(p_user bigint)
returns table (miner_id bigint, type_id bigint, type_name text, level int, max_level int,
               income_per_hour bigint, pending bigint, pending_max bigint, upgrade_cost bigint)
language sql stable security definer set search_path = public as $$
  select um.id, mt.id, mt.name, um.level, mt.max_level,
         miner_rate(mt.base_income, um.level),
         miner_pending(miner_rate(mt.base_income, um.level), um.last_collected_at, clock_timestamp()),
         miner_rate(mt.base_income, um.level) * miners_cap_hours(),
         case when um.level < mt.max_level then miner_upgrade_cost(mt.upgrade_base, um.level) end
  from user_miners um join miner_types mt on mt.id = um.miner_type_id
  where um.user_id = p_user
  order by um.id
$$;

-- Купить детали за монеты
create or replace function part_buy(p_user bigint, p_part bigint, p_qty int)
returns table (new_balance bigint, new_qty bigint)
language plpgsql security definer set search_path = public as $$
declare
  v_price   bigint;
  v_balance bigint;
  v_cost    bigint;
  v_have    bigint;
begin
  if p_qty is null or p_qty < 1 or p_qty > 100 then raise exception 'bad_qty'; end if;
  select pt.shop_price into v_price from part_types pt where pt.id = p_part;
  if not found then raise exception 'bad_part'; end if;

  select u.balance into v_balance from users u where u.id = p_user for update;
  if not found then raise exception 'user_not_found'; end if;

  v_cost := v_price * p_qty;
  if v_balance < v_cost then raise exception 'insufficient_funds'; end if;
  v_balance := v_balance - v_cost;
  update users set balance = v_balance where id = p_user;
  insert into ledger (user_id, amount, balance_after, reason) values (p_user, -v_cost, v_balance, 'part_buy');

  insert into parts_inventory (user_id, part_type_id, qty) values (p_user, p_part, p_qty)
  on conflict (user_id, part_type_id) do update set qty = parts_inventory.qty + excluded.qty
  returning qty into v_have;

  new_balance := v_balance; new_qty := v_have;
  return next;
end;
$$;

-- Собрать майнер: все детали по рецепту списываются разом (или ничего).
create or replace function miner_build(p_user bigint, p_type bigint)
returns table (new_miner_id bigint)
language plpgsql security definer set search_path = public as $$
declare
  v_active bool;
  v_count  int;
  r        record;
  v_have   bigint;
  v_id     bigint;
begin
  select mt.active into v_active from miner_types mt where mt.id = p_type;
  if not found or not v_active then raise exception 'bad_type'; end if;
  if not exists (select 1 from miner_recipes mr where mr.miner_type_id = p_type) then raise exception 'bad_type'; end if;

  perform 1 from users u where u.id = p_user for update;     -- сериализует все действия игрока
  if not found then raise exception 'user_not_found'; end if;

  select count(*)::int into v_count from user_miners um where um.user_id = p_user;
  if v_count >= miners_max_per_user() then raise exception 'miner_limit'; end if;

  for r in select mr.part_type_id as pid, mr.qty as need from miner_recipes mr
           where mr.miner_type_id = p_type order by mr.part_type_id loop
    select pi.qty into v_have from parts_inventory pi
    where pi.user_id = p_user and pi.part_type_id = r.pid for update;
    if not found or v_have < r.need then raise exception 'not_enough_parts'; end if;
    update parts_inventory set qty = qty - r.need where user_id = p_user and part_type_id = r.pid;
  end loop;

  insert into user_miners (user_id, miner_type_id, last_collected_at)
  values (p_user, p_type, clock_timestamp()) returning id into v_id;

  new_miner_id := v_id;
  return next;
end;
$$;

-- Собрать доход со всех майнеров. Таймер сбрасывается только у тех, с кого что-то выплачено
-- (дробная доля меньше монеты не пропадает при частых нажатиях).
create or replace function miners_collect(p_user bigint)
returns table (collected bigint, new_balance bigint)
language plpgsql security definer set search_path = public as $$
declare
  v_now     timestamptz := clock_timestamp();
  v_balance bigint;
  v_total   bigint;
begin
  select u.balance into v_balance from users u where u.id = p_user for update;
  if not found then raise exception 'user_not_found'; end if;

  with calc as (
    select um.id, miner_pending(miner_rate(mt.base_income, um.level), um.last_collected_at, v_now) as pend
    from user_miners um join miner_types mt on mt.id = um.miner_type_id
    where um.user_id = p_user
  ), upd as (
    update user_miners um set last_collected_at = v_now
    from calc where um.id = calc.id and calc.pend > 0
    returning calc.pend
  )
  select coalesce(sum(pend), 0)::bigint into v_total from upd;

  if v_total > 0 then
    v_balance := v_balance + v_total;
    update users set balance = v_balance where id = p_user;
    insert into ledger (user_id, amount, balance_after, reason) values (p_user, v_total, v_balance, 'miner_income');
  end if;

  collected := v_total; new_balance := v_balance;
  return next;
end;
$$;

-- Улучшить майнер. Накопленный доход выплачивается по старой ставке, затем списывается цена улучшения.
create or replace function miner_upgrade(p_user bigint, p_miner bigint)
returns table (new_balance bigint, new_level int, paid bigint)
language plpgsql security definer set search_path = public as $$
declare
  v_now     timestamptz := clock_timestamp();
  v_balance bigint;
  v_level   int;
  v_last    timestamptz;
  v_base    bigint;
  v_upg     bigint;
  v_max     int;
  v_pending bigint;
  v_cost    bigint;
begin
  select u.balance into v_balance from users u where u.id = p_user for update;
  if not found then raise exception 'user_not_found'; end if;

  select um.level, um.last_collected_at, mt.base_income, mt.upgrade_base, mt.max_level
  into v_level, v_last, v_base, v_upg, v_max
  from user_miners um join miner_types mt on mt.id = um.miner_type_id
  where um.id = p_miner and um.user_id = p_user for update of um;
  if not found then raise exception 'miner_not_found'; end if;
  if v_level >= v_max then raise exception 'max_level'; end if;

  v_pending := miner_pending(miner_rate(v_base, v_level), v_last, v_now);   -- по старому уровню
  v_cost    := miner_upgrade_cost(v_upg, v_level);

  if v_balance + v_pending < v_cost then raise exception 'insufficient_funds'; end if;

  if v_pending > 0 then
    v_balance := v_balance + v_pending;
    insert into ledger (user_id, amount, balance_after, reason) values (p_user, v_pending, v_balance, 'miner_income');
  end if;

  v_balance := v_balance - v_cost;
  update users set balance = v_balance where id = p_user;
  insert into ledger (user_id, amount, balance_after, reason) values (p_user, -v_cost, v_balance, 'miner_upgrade');

  update user_miners set level = level + 1, last_collected_at = v_now where id = p_miner;

  new_balance := v_balance; new_level := v_level + 1; paid := v_pending;
  return next;
end;
$$;

-- Колесо: теперь выдаёт и детали
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
  elsif v_prize.kind = 'part' then
    insert into parts_inventory (user_id, part_type_id, qty) values (p_user, v_prize.part_type_id, v_prize.value)
    on conflict (user_id, part_type_id) do update set qty = parts_inventory.qty + excluded.qty;
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

revoke all on function miners_max_per_user(), miners_cap_hours(), miner_rate(bigint, int),
  miner_upgrade_cost(bigint, int), miner_pending(bigint, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function miners_config(), miners_overview(bigint), part_buy(bigint, bigint, int), miner_build(bigint, bigint),
  miners_collect(bigint), miner_upgrade(bigint, bigint), wheel_spin(bigint, text) from public, anon, authenticated;
grant execute on function miners_config(), miners_overview(bigint), part_buy(bigint, bigint, int), miner_build(bigint, bigint),
  miners_collect(bigint), miner_upgrade(bigint, bigint), wheel_spin(bigint, text) to service_role;

notify pgrst, 'reload schema';
