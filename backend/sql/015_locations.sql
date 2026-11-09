-- Этап 11: локации вместо майнеров. Выполнить целиком в Supabase -> SQL Editor.
--
-- Правила:
--  * Локация (ларёк, магазин, столовая, ресторан) покупается за монеты и прокачивается за монеты.
--    Никаких деталей: «просто за деньги покупаешь карточку и прокачиваешь».
--  * Цена уровня L (покупка = уровень 1): base_price * рост_цены^(L-1).
--  * Доход в час на уровне L: base_income * рост_дохода^(L-1).
--  * Доход копится не дольше locations_cap_hours часов, потом его нужно собрать.
--  * Прокачка сначала выплачивает накопленное по старому уровню, затем поднимает уровень.
--  * Цены, доходы и картинки меняет админ (таблица location_types, ключи settings).
--  * Майнеры отключаются: перед этим всем игрокам выплачивается накопленный доход майнеров.

create table if not exists location_types (
  id          bigint generated always as identity primary key,
  code        text   not null unique,
  name        text   not null check (char_length(name) between 1 and 40),
  image_url   text,                                        -- своя картинка (иначе рисунок по умолчанию)
  base_price  bigint not null check (base_price > 0),      -- цена покупки (уровень 1)
  base_income bigint not null check (base_income > 0),     -- монет в час на уровне 1
  max_level   int    not null default 25 check (max_level >= 1),
  sort        int    not null default 0,
  active      boolean not null default true
);

create table if not exists user_locations (
  user_id           bigint not null references users(id),
  location_type_id  bigint not null references location_types(id),
  level             int    not null default 1 check (level >= 1),
  last_collected_at timestamptz not null default now(),
  primary key (user_id, location_type_id)
);

alter table location_types enable row level security;
alter table user_locations enable row level security;

insert into location_types (code, name, base_price, base_income, sort) values
  ('stall',      'Ларёк',    500,   40,   1),
  ('shop',       'Магазин',  3000,  200,  2),
  ('canteen',    'Столовая', 15000, 900,  3),
  ('restaurant', 'Ресторан', 75000, 4000, 4)
on conflict (code) do nothing;

create or replace function locations_cap_hours() returns numeric language sql stable as $$
  select setting_num('locations_cap_hours', 3) $$;
create or replace function location_price_growth() returns numeric language sql stable as $$
  select setting_num('location_price_growth', 1.6) $$;
create or replace function location_income_growth() returns numeric language sql stable as $$
  select setting_num('location_income_growth', 1.4) $$;

-- Цена получения уровня L (L = 1 — покупка)
create or replace function location_cost(p_base bigint, p_level int) returns bigint language sql stable as $$
  select floor(p_base * power(location_price_growth(), p_level - 1))::bigint $$;
-- Доход в час на уровне L (0 — не куплено)
create or replace function location_rate(p_base bigint, p_level int) returns bigint language sql stable as $$
  select case when p_level <= 0 then 0 else floor(p_base * power(location_income_growth(), p_level - 1))::bigint end $$;
create or replace function location_pending(p_rate bigint, p_last timestamptz, p_now timestamptz) returns bigint
language sql stable as $$
  select floor(p_rate * least(greatest(extract(epoch from (p_now - p_last))::numeric, 0), locations_cap_hours() * 3600) / 3600.0)::bigint
$$;

-- Все активные локации (и купленные, даже если админ их выключил) с уровнем игрока.
create or replace function locations_overview(p_user bigint)
returns table (type_id bigint, code text, name text, image_url text, level int, max_level int,
               income_per_hour bigint, next_income bigint, upgrade_cost bigint, pending bigint, pending_max bigint)
language sql stable security definer set search_path = public as $$
  select lt.id, lt.code, lt.name, lt.image_url, coalesce(ul.level, 0), lt.max_level,
         location_rate(lt.base_income, coalesce(ul.level, 0)),
         case when coalesce(ul.level, 0) < lt.max_level then location_rate(lt.base_income, coalesce(ul.level, 0) + 1) end,
         case when coalesce(ul.level, 0) < lt.max_level and (lt.active or ul.level is not null)
              then location_cost(lt.base_price, coalesce(ul.level, 0) + 1) end,
         case when ul.level is null then 0
              else location_pending(location_rate(lt.base_income, ul.level), ul.last_collected_at, clock_timestamp()) end,
         floor(location_rate(lt.base_income, coalesce(ul.level, 0)) * locations_cap_hours())::bigint
  from location_types lt
  left join user_locations ul on ul.location_type_id = lt.id and ul.user_id = p_user
  where lt.active or ul.level is not null
  order by lt.sort, lt.id
$$;

-- Купить (если ещё нет) или прокачать локацию.
create or replace function location_upgrade(p_user bigint, p_type bigint)
returns table (new_balance bigint, new_level int, paid bigint)
language plpgsql security definer set search_path = public as $$
declare
  v_now     timestamptz := clock_timestamp();
  v_balance bigint;
  v_price   bigint;
  v_income  bigint;
  v_max     int;
  v_active  boolean;
  v_level   int;
  v_last    timestamptz;
  v_pending bigint := 0;
  v_cost    bigint;
begin
  select u.balance into v_balance from users u where u.id = p_user for update;
  if not found then raise exception 'user_not_found'; end if;

  select lt.base_price, lt.base_income, lt.max_level, lt.active into v_price, v_income, v_max, v_active
  from location_types lt where lt.id = p_type;
  if not found then raise exception 'location_not_found'; end if;

  select ul.level, ul.last_collected_at into v_level, v_last
  from user_locations ul where ul.user_id = p_user and ul.location_type_id = p_type for update;
  if not found then
    if not v_active then raise exception 'location_not_found'; end if;  -- выключенную купить нельзя
    v_level := 0;
  end if;
  if v_level >= v_max then raise exception 'max_level'; end if;

  if v_level > 0 then
    v_pending := location_pending(location_rate(v_income, v_level), v_last, v_now);   -- по старому уровню
  end if;
  v_cost := location_cost(v_price, v_level + 1);
  if v_balance + v_pending < v_cost then raise exception 'insufficient_funds'; end if;

  if v_pending > 0 then
    v_balance := v_balance + v_pending;
    insert into ledger (user_id, amount, balance_after, reason) values (p_user, v_pending, v_balance, 'location_income');
  end if;
  v_balance := v_balance - v_cost;
  update users set balance = v_balance where id = p_user;
  insert into ledger (user_id, amount, balance_after, reason)
  values (p_user, -v_cost, v_balance, case when v_level = 0 then 'location_buy' else 'location_upgrade' end);

  insert into user_locations (user_id, location_type_id, level, last_collected_at) values (p_user, p_type, 1, v_now)
  on conflict (user_id, location_type_id) do update set level = user_locations.level + 1, last_collected_at = v_now;

  new_balance := v_balance; new_level := v_level + 1; paid := v_pending;
  return next;
end;
$$;

-- Собрать доход со всех локаций. Таймер сбрасывается только там, где что-то выплачено.
create or replace function locations_collect(p_user bigint)
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
    select ul.location_type_id as tid,
           location_pending(location_rate(lt.base_income, ul.level), ul.last_collected_at, v_now) as pend
    from user_locations ul join location_types lt on lt.id = ul.location_type_id
    where ul.user_id = p_user
  ), upd as (
    update user_locations ul set last_collected_at = v_now
    from calc where ul.user_id = p_user and ul.location_type_id = calc.tid and calc.pend > 0
    returning calc.pend
  )
  select coalesce(sum(pend), 0)::bigint into v_total from upd;

  if v_total > 0 then
    v_balance := v_balance + v_total;
    update users set balance = v_balance where id = p_user;
    insert into ledger (user_id, amount, balance_after, reason) values (p_user, v_total, v_balance, 'location_income');
  end if;

  collected := v_total; new_balance := v_balance;
  return next;
end;
$$;

-- Майнеры уходят: выплачиваем всем накопленный доход, чтобы ничего не пропало.
do $$
declare r record;
begin
  for r in select distinct um.user_id from user_miners um order by um.user_id loop
    perform miners_collect(r.user_id);
  end loop;
end $$;
update miner_types set active = false;

revoke all on function locations_cap_hours(), location_price_growth(), location_income_growth(),
  location_cost(bigint, int), location_rate(bigint, int), location_pending(bigint, timestamptz, timestamptz)
  from public, anon, authenticated;
revoke all on function locations_overview(bigint), location_upgrade(bigint, bigint), locations_collect(bigint)
  from public, anon, authenticated;
grant execute on function locations_overview(bigint), location_upgrade(bigint, bigint), locations_collect(bigint)
  to service_role;

notify pgrst, 'reload schema';
