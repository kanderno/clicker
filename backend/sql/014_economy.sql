-- Этап 10: прокачка удара, стрики, кражи-заряды, лиги и лидерборды, аватарки. Выполнить целиком в Supabase -> SQL Editor.
--
-- Что меняется:
--  1. settings — настройки игры (цены, проценты, награды). Админ меняет их из приложения,
--     SQL-функции читают отсюда (если ключа нет, берётся значение по умолчанию из кода).
--  2. Прокачка удара: tap_level. Монет за тап = уровень. Лимит 15 тапов/сек прежний.
--  3. Стрик: награда за каждый день подряд в игре (монеты, бонусные спины, заряды кражи), цикл 7 дней.
--  4. Кража теперь не случайная: колесо (или стрик, или покупка) даёт ЗАРЯД кражи,
--     игрок сам выбирает жертву в лидерборде. Крадётся случайно 2–10% кошелька жертвы.
--     Заряд можно подарить другому игроку.
--  5. Лиги: по максимальному балансу за всё время (peak_balance). Порог пройден — ты в новой лиге
--     навсегда. Раз в неделю топ-3 каждой лиги получают награду лиги.
--  6. users.photo_url — аватарка из Telegram.

-- ---------- 1. Настройки ----------
create table if not exists settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
alter table settings enable row level security;

create or replace function setting_num(p_key text, p_default numeric) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce((select (s.value #>> '{}')::numeric from settings s where s.key = p_key), p_default)
$$;

create or replace function setting_json(p_key text, p_default jsonb) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select s.value from settings s where s.key = p_key), p_default)
$$;

-- Награды стрика по дням цикла (7 дней): coins — монеты, spins — бонусные спины, steals — заряды кражи.
create or replace function streak_default_rewards() returns jsonb language sql immutable as $$
  select '[{"coins":100},{"coins":250},{"spins":1},{"coins":500},{"coins":1000},{"coins":1500,"spins":1},{"coins":3000,"steals":1}]'::jsonb
$$;

-- Старые константы теперь читаются из настроек (значения по умолчанию прежние или из ТЗ).
create or replace function wheel_price() returns bigint language sql stable as $$
  select setting_num('wheel_price', 150)::bigint $$;
create or replace function wheel_max_paid() returns int language sql stable as $$
  select setting_num('wheel_max_paid', 5)::int $$;
create or replace function steal_pct_min() returns numeric language sql stable as $$
  select setting_num('steal_pct_min', 2) $$;
create or replace function steal_pct_max() returns numeric language sql stable as $$
  select setting_num('steal_pct_max', 10) $$;
create or replace function steal_cap() returns bigint language sql stable as $$
  select setting_num('steal_cap', 0)::bigint $$;                     -- 0 = без потолка
create or replace function steal_price() returns bigint language sql stable as $$
  select setting_num('steal_price', 1000)::bigint $$;
create or replace function steal_max_charges() returns int language sql stable as $$
  select setting_num('steal_max_charges', 20)::int $$;
create or replace function tap_upgrade_base() returns numeric language sql stable as $$
  select setting_num('tap_upgrade_base', 200) $$;
create or replace function tap_upgrade_growth() returns numeric language sql stable as $$
  select setting_num('tap_upgrade_growth', 1.35) $$;
create or replace function tap_max_level() returns int language sql stable as $$
  select setting_num('tap_max_level', 30)::int $$;

-- ---------- 2. Новые поля игрока ----------
alter table users add column if not exists photo_url     text;
alter table users add column if not exists tap_level     int    not null default 1;
alter table users add column if not exists steal_charges int    not null default 0;
alter table users add column if not exists bonus_spins   int    not null default 0;
alter table users add column if not exists peak_balance  bigint not null default 0;
alter table users drop constraint if exists users_tap_level_check;
alter table users add constraint users_tap_level_check check (tap_level >= 1);
alter table users drop constraint if exists users_steal_charges_check;
alter table users add constraint users_steal_charges_check check (steal_charges >= 0);
alter table users drop constraint if exists users_bonus_spins_check;
alter table users add constraint users_bonus_spins_check check (bonus_spins >= 0);

-- Максимальный баланс за всё время: обновляется сам при любом изменении баланса.
create or replace function users_track_peak() returns trigger language plpgsql as $$
begin
  new.peak_balance := greatest(coalesce(new.peak_balance, 0), coalesce(new.balance, 0));
  return new;
end;
$$;
drop trigger if exists users_peak_balance on users;
create trigger users_peak_balance before insert or update of balance on users
  for each row execute function users_track_peak();
update users set peak_balance = greatest(peak_balance, balance) where peak_balance < balance;

-- ---------- 3. Прокачка удара ----------
create or replace function tap_power(p_level int) returns bigint language sql immutable as $$
  select greatest(p_level, 1)::bigint $$;

-- Цена улучшения с уровня L на L+1. null — уровень максимальный.
create or replace function tap_upgrade_cost(p_level int) returns bigint language sql stable as $$
  select case when p_level >= tap_max_level() then null
              else floor(tap_upgrade_base() * power(tap_upgrade_growth(), p_level - 1))::bigint end
$$;

-- Тапы: прежний лимит 15 кликов/сек, но каждый тап приносит tap_power(уровень) монет.
create or replace function apply_taps(p_user bigint, p_count int)
returns table (new_balance bigint, accepted int)
language plpgsql
security definer
set search_path = public
as $$
declare
  c_rate          constant int     := 15;
  c_max_elapsed   constant numeric := 30;
  c_first_elapsed constant numeric := 10;
  v_last    timestamptz;
  v_balance bigint;
  v_level   int;
  v_now     timestamptz := clock_timestamp();
  v_elapsed numeric;
  v_allowed int;
  v_coins   bigint;
begin
  if p_count is null or p_count <= 0 then
    raise exception 'bad_count';
  end if;

  select u.balance, u.last_tap_at, u.tap_level into v_balance, v_last, v_level
  from users u where u.id = p_user for update;
  if not found then
    raise exception 'user_not_found';
  end if;

  if v_last is null then
    v_elapsed := c_first_elapsed;
  else
    v_elapsed := least(extract(epoch from (v_now - v_last)), c_max_elapsed);
  end if;

  v_allowed := least(p_count, floor(v_elapsed * c_rate)::int);

  if v_allowed <= 0 then
    new_balance := v_balance;
    accepted := 0;
    return next;
    return;
  end if;

  v_coins := v_allowed * tap_power(v_level);
  v_balance := v_balance + v_coins;
  update users set balance = v_balance, last_tap_at = v_now where id = p_user;
  insert into ledger (user_id, amount, balance_after, reason)
  values (p_user, v_coins, v_balance, 'tap');

  new_balance := v_balance;
  accepted := v_allowed;
  return next;
end;
$$;

create or replace function tap_upgrade(p_user bigint)
returns table (new_balance bigint, new_level int, next_cost bigint)
language plpgsql security definer set search_path = public as $$
declare
  v_balance bigint;
  v_level   int;
  v_cost    bigint;
begin
  select u.balance, u.tap_level into v_balance, v_level from users u where u.id = p_user for update;
  if not found then raise exception 'user_not_found'; end if;

  v_cost := tap_upgrade_cost(v_level);
  if v_cost is null then raise exception 'max_level'; end if;
  if v_balance < v_cost then raise exception 'insufficient_funds'; end if;

  v_balance := v_balance - v_cost;
  v_level := v_level + 1;
  update users set balance = v_balance, tap_level = v_level where id = p_user;
  insert into ledger (user_id, amount, balance_after, reason) values (p_user, -v_cost, v_balance, 'tap_upgrade');

  new_balance := v_balance; new_level := v_level; next_cost := tap_upgrade_cost(v_level);
  return next;
end;
$$;

-- ---------- 4. Стрик ----------
create table if not exists streaks (
  user_id    bigint primary key references users(id),
  day_count  int  not null default 0,          -- сколько дней подряд забрана награда
  last_claim date                              -- день (UTC) последней награды
);
alter table streaks enable row level security;

create or replace function streak_rewards() returns jsonb language sql stable as $$
  select setting_json('streak_rewards', streak_default_rewards()) $$;

create or replace function streak_claim(p_user bigint)
returns table (day_count int, coins bigint, spins int, steals int, new_balance bigint)
language plpgsql security definer set search_path = public as $$
declare
  v_today   date := (clock_timestamp() at time zone 'utc')::date;
  v_last    date;
  v_count   int;
  v_rewards jsonb := streak_rewards();
  v_len     int;
  v_reward  jsonb;
  v_coins   bigint;
  v_spins   int;
  v_steals  int;
  v_balance bigint;
begin
  select u.balance into v_balance from users u where u.id = p_user for update;
  if not found then raise exception 'user_not_found'; end if;

  select s.day_count, s.last_claim into v_count, v_last from streaks s where s.user_id = p_user for update;
  if v_last = v_today then raise exception 'already_claimed'; end if;
  v_count := case when v_last = v_today - 1 then v_count + 1 else 1 end;

  v_len := greatest(jsonb_array_length(v_rewards), 1);
  v_reward := coalesce(v_rewards -> ((v_count - 1) % v_len), '{}'::jsonb);
  v_coins  := greatest(coalesce((v_reward ->> 'coins')::bigint, 0), 0);
  v_spins  := greatest(coalesce((v_reward ->> 'spins')::int, 0), 0);
  v_steals := greatest(coalesce((v_reward ->> 'steals')::int, 0), 0);

  insert into streaks (user_id, day_count, last_claim) values (p_user, v_count, v_today)
  on conflict (user_id) do update set day_count = excluded.day_count, last_claim = excluded.last_claim;

  v_balance := v_balance + v_coins;
  update users u set balance = v_balance, bonus_spins = u.bonus_spins + v_spins,
                     steal_charges = least(u.steal_charges + v_steals, greatest(steal_max_charges(), u.steal_charges))
  where u.id = p_user;
  if v_coins > 0 then
    insert into ledger (user_id, amount, balance_after, reason) values (p_user, v_coins, v_balance, 'streak');
  end if;

  day_count := v_count; coins := v_coins; spins := v_spins; steals := v_steals; new_balance := v_balance;
  return next;
end;
$$;

-- ---------- 5. Колесо: бонусные спины, кража = заряд ----------
alter table spins add column if not exists bonus boolean not null default false;

-- Подписи «Free 100» были непонятны: это бесплатная ставка в прогнозах.
update prizes set label = 'Фрибет ' || value where kind = 'free_bet' and label = 'Free ' || value;
-- Детали майнеров больше не нужны (майнеры заменяются локациями).
update prizes set active = false where kind = 'part';

drop function if exists wheel_state(bigint);
create or replace function wheel_state(p_user bigint)
returns table (free_available boolean, paid_today int, paid_max int, price bigint, seconds_to_reset int,
               bonus_spins int, steal_charges int)
language plpgsql security definer set search_path = public
as $$
declare
  v_day date := (clock_timestamp() at time zone 'utc')::date;
begin
  select u.bonus_spins, u.steal_charges into bonus_spins, steal_charges from users u where u.id = p_user;
  if not found then raise exception 'user_not_found'; end if;

  free_available := not exists (select 1 from spins s where s.user_id = p_user and s.spin_day = v_day and not s.paid);
  select count(*)::int into paid_today from spins s
  where s.user_id = p_user and s.spin_day = v_day and s.paid and not s.bonus;
  paid_max := wheel_max_paid();
  price := wheel_price();
  seconds_to_reset := floor(extract(epoch from ((v_day + 1)::timestamp - (clock_timestamp() at time zone 'utc'))))::int;
  return next;
end;
$$;

-- Режимы: 'free' (раз в сутки), 'paid' (за монеты), 'bonus' (бонусный спин из стрика).
create or replace function wheel_spin(p_user bigint, p_mode text)
returns table (prize_id bigint, prize_label text, prize_kind text, prize_value bigint, new_balance bigint, was_free boolean)
language plpgsql security definer set search_path = public
as $$
declare
  v_day     date := (clock_timestamp() at time zone 'utc')::date;
  v_balance bigint;
  v_bonus   int;
  v_charges int;
  v_paid    int;
  v_prize   prizes%rowtype;
  v_pick    bigint;
begin
  if p_mode is null or p_mode not in ('free', 'paid', 'bonus') then raise exception 'bad_mode'; end if;

  select u.balance, u.bonus_spins, u.steal_charges into v_balance, v_bonus, v_charges
  from users u where u.id = p_user for update;
  if not found then raise exception 'user_not_found'; end if;

  if p_mode = 'free' then
    if exists (select 1 from spins s where s.user_id = p_user and s.spin_day = v_day and not s.paid) then
      raise exception 'free_spin_used';
    end if;
  elsif p_mode = 'bonus' then
    if v_bonus <= 0 then raise exception 'no_bonus_spins'; end if;
    update users set bonus_spins = bonus_spins - 1 where id = p_user;
  else
    select count(*)::int into v_paid from spins s
    where s.user_id = p_user and s.spin_day = v_day and s.paid and not s.bonus;
    if v_paid >= wheel_max_paid() then raise exception 'paid_limit'; end if;
    if v_balance < wheel_price() then raise exception 'insufficient_funds'; end if;
    v_balance := v_balance - wheel_price();
    update users set balance = v_balance where id = p_user;
    insert into ledger (user_id, amount, balance_after, reason) values (p_user, -wheel_price(), v_balance, 'spin_buy');
  end if;

  -- Если зарядов кражи уже максимум, сектор кражи в этот раз не выпадает.
  v_pick := wheel_pick_prize(v_charges < steal_max_charges());
  if v_pick is null then raise exception 'no_prizes'; end if;
  select * into v_prize from prizes where id = v_pick;

  if v_prize.kind = 'coins' then
    v_balance := v_balance + v_prize.value;
    update users set balance = v_balance where id = p_user;
    insert into ledger (user_id, amount, balance_after, reason) values (p_user, v_prize.value, v_balance, 'spin_prize');
  elsif v_prize.kind = 'free_bet' then
    insert into free_bets (user_id, amount, source) values (p_user, v_prize.value, 'wheel');
  elsif v_prize.kind = 'steal' then
    update users set steal_charges = steal_charges + 1 where id = p_user;
  elsif v_prize.kind = 'part' then
    insert into parts_inventory (user_id, part_type_id, qty) values (p_user, v_prize.part_type_id, v_prize.value)
    on conflict (user_id, part_type_id) do update set qty = parts_inventory.qty + excluded.qty;
  else
    raise exception 'prize_not_supported';
  end if;

  insert into spins (user_id, prize_id, kind, value, paid, bonus, spin_day)
  values (p_user, v_prize.id, v_prize.kind, case when v_prize.kind = 'steal' then 1 else v_prize.value end,
          p_mode <> 'free', p_mode = 'bonus', v_day);

  prize_id := v_prize.id; prize_label := v_prize.label; prize_kind := v_prize.kind;
  prize_value := case when v_prize.kind = 'steal' then 1 else v_prize.value end;
  new_balance := v_balance; was_free := p_mode <> 'paid';
  return next;
end;
$$;

-- ---------- 6. Кражи: применить, купить, подарить ----------
-- Украсть у выбранного игрока. Тратится один заряд. Жертва видит уведомление, вор анонимен.
create or replace function steal_player(p_thief bigint, p_victim bigint)
returns table (stolen bigint, new_balance bigint, charges_left int)
language plpgsql security definer set search_path = public as $$
declare
  v_balance bigint;
  v_charges int;
  v_vbal    bigint;
  v_created timestamptz;
  v_amount  bigint;
begin
  if p_thief = p_victim then raise exception 'self_steal'; end if;

  -- Оба игрока блокируются по возрастанию id (как в переводах): встречные кражи не дадут deadlock.
  perform 1 from users u where u.id in (p_thief, p_victim) order by u.id for update;

  select u.balance, u.steal_charges into v_balance, v_charges from users u where u.id = p_thief;
  if not found then raise exception 'user_not_found'; end if;
  select u.balance, u.created_at into v_vbal, v_created from users u where u.id = p_victim;
  if not found then raise exception 'victim_not_found'; end if;

  if v_charges <= 0 then raise exception 'no_steal_charges'; end if;
  if v_vbal <= steal_min_balance() then raise exception 'victim_too_poor'; end if;
  if v_created > clock_timestamp() - make_interval(hours => steal_newbie_hours()) then
    raise exception 'victim_protected';
  end if;
  if (select count(*) from steals s
      where s.victim_id = p_victim and s.created_at > clock_timestamp() - interval '24 hours') >= steal_victim_cap() then
    raise exception 'victim_protected';
  end if;

  v_amount := greatest(1, floor(v_vbal * (steal_pct_min() + (steal_pct_max() - steal_pct_min()) * rand01()) / 100))::bigint;
  if steal_cap() > 0 then v_amount := least(v_amount, steal_cap()); end if;
  v_amount := least(v_amount, v_vbal);

  update users set balance = v_vbal - v_amount where id = p_victim;
  insert into ledger (user_id, amount, balance_after, reason) values (p_victim, -v_amount, v_vbal - v_amount, 'stolen');

  v_balance := v_balance + v_amount;
  v_charges := v_charges - 1;
  update users set balance = v_balance, steal_charges = v_charges where id = p_thief;
  insert into ledger (user_id, amount, balance_after, reason) values (p_thief, v_amount, v_balance, 'steal');

  insert into steals (thief_id, victim_id, amount) values (p_thief, p_victim, v_amount);

  stolen := v_amount; new_balance := v_balance; charges_left := v_charges;
  return next;
end;
$$;

create or replace function steal_buy(p_user bigint)
returns table (new_balance bigint, charges int)
language plpgsql security definer set search_path = public as $$
declare
  v_balance bigint;
  v_charges int;
  v_price   bigint := steal_price();
begin
  select u.balance, u.steal_charges into v_balance, v_charges from users u where u.id = p_user for update;
  if not found then raise exception 'user_not_found'; end if;
  if v_charges >= steal_max_charges() then raise exception 'steal_limit'; end if;
  if v_balance < v_price then raise exception 'insufficient_funds'; end if;

  v_balance := v_balance - v_price;
  v_charges := v_charges + 1;
  update users set balance = v_balance, steal_charges = v_charges where id = p_user;
  insert into ledger (user_id, amount, balance_after, reason) values (p_user, -v_price, v_balance, 'steal_buy');

  new_balance := v_balance; charges := v_charges;
  return next;
end;
$$;

-- Подарить заряд кражи другому игроку. Получатель видит уведомление с именем дарителя.
create or replace function steal_gift(p_from bigint, p_to bigint)
returns table (charges_left int)
language plpgsql security definer set search_path = public as $$
declare
  v_charges    int;
  v_to_charges int;
  v_name       text;
begin
  if p_from = p_to then raise exception 'self_transfer'; end if;
  perform 1 from users u where u.id in (p_from, p_to) order by u.id for update;

  select u.steal_charges, coalesce(u.first_name, '@' || u.username, 'Игрок') into v_charges, v_name
  from users u where u.id = p_from;
  if not found then raise exception 'user_not_found'; end if;
  select u.steal_charges into v_to_charges from users u where u.id = p_to;
  if not found then raise exception 'recipient_not_found'; end if;

  if v_charges <= 0 then raise exception 'no_steal_charges'; end if;
  if v_to_charges >= steal_max_charges() then raise exception 'steal_limit'; end if;

  update users set steal_charges = steal_charges - 1 where id = p_from;
  update users set steal_charges = steal_charges + 1 where id = p_to;
  insert into notices (user_id, kind, amount, title, body) values (p_to, 'steal_gift', 1, v_name, null);

  charges_left := v_charges - 1;
  return next;
end;
$$;

-- ---------- 7. Лиги и лидерборды ----------
create table if not exists leagues (
  id       bigint generated always as identity primary key,
  name     text   not null check (char_length(name) between 1 and 40),
  min_peak bigint not null unique check (min_peak >= 0),    -- порог: максимальный баланс за всё время
  reward_1 bigint not null default 0 check (reward_1 >= 0), -- недельные награды за 1–3 место в лиге
  reward_2 bigint not null default 0 check (reward_2 >= 0),
  reward_3 bigint not null default 0 check (reward_3 >= 0)
);
alter table leagues enable row level security;

insert into leagues (name, min_peak, reward_1, reward_2, reward_3)
select * from (values
  ('Бронза',   0::bigint,        500::bigint,    300::bigint,    150::bigint),
  ('Серебро',  10000,            2000,           1200,           600),
  ('Золото',   100000,           10000,          6000,           3000),
  ('Платина',  1000000,          50000,          30000,          15000),
  ('Алмаз',    10000000,         250000,         150000,         75000)
) as t
where not exists (select 1 from leagues);

create or replace function league_of(p_peak bigint) returns bigint
language sql stable security definer set search_path = public as $$
  select l.id from leagues l where l.min_peak <= p_peak order by l.min_peak desc, l.id limit 1
$$;

-- Топ игроков: глобальный и в лиге игрока. Плюс строка самого игрока, если он не в топе.
create or replace function leaderboard_view(p_user bigint, p_limit int default 20)
returns table (scope text, place bigint, user_id bigint, username text, first_name text, photo_url text,
               balance bigint, league_id bigint)
language sql stable security definer set search_path = public as $$
  with ranked as (
    select u.id, u.username, u.first_name, u.photo_url, u.balance, league_of(u.peak_balance) as lg
    from users u
  ), mine as (
    select r.lg from ranked r where r.id = p_user
  ), g as (
    select 'global'::text as scope, row_number() over (order by r.balance desc, r.id) as place, r.*
    from ranked r
  ), l as (
    select 'league'::text as scope, row_number() over (order by r.balance desc, r.id) as place, r.*
    from ranked r where r.lg is not distinct from (select lg from mine)
  )
  select g.scope, g.place, g.id, g.username, g.first_name, g.photo_url, g.balance, g.lg
  from g where g.place <= p_limit or g.id = p_user
  union all
  select l.scope, l.place, l.id, l.username, l.first_name, l.photo_url, l.balance, l.lg
  from l where l.place <= p_limit or l.id = p_user
$$;

-- Недельные награды лиг. Считаются «лениво»: при первом открытии лидерборда после конца недели
-- топ-3 каждой лиги (по балансу на этот момент) получают награду. Повторно неделя не платится.
create table if not exists league_settlements (
  week_start date primary key,
  settled_at timestamptz not null default now()
);
create table if not exists league_payouts (
  id         bigint generated always as identity primary key,
  week_start date   not null references league_settlements(week_start),
  league_id  bigint not null references leagues(id),
  place      int    not null check (place between 1 and 3),
  user_id    bigint not null references users(id),
  amount     bigint not null check (amount > 0),
  created_at timestamptz not null default now(),
  unique (week_start, league_id, place)
);
alter table league_settlements enable row level security;
alter table league_payouts enable row level security;

-- Первая выплата — по итогам текущей недели, а не сразу после запуска.
insert into league_settlements (week_start)
values ((date_trunc('week', now() at time zone 'utc'))::date - 7)
on conflict do nothing;

create or replace function league_settle() returns int
language plpgsql security definer set search_path = public as $$
declare
  v_week date := (date_trunc('week', clock_timestamp() at time zone 'utc'))::date - 7;  -- прошлая неделя
  v_count int := 0;
  v_bal   bigint;
  r       record;
begin
  insert into league_settlements (week_start) values (v_week) on conflict do nothing;
  if not found then return 0; end if;  -- уже выплачено (или выплачивается параллельно)

  for r in
    with ranked as (
      select u.id, u.balance, league_of(u.peak_balance) as lg from users u where u.balance > 0
    ), p as (
      select ranked.id, ranked.lg, row_number() over (partition by ranked.lg order by ranked.balance desc, ranked.id) as place
      from ranked where ranked.lg is not null
    )
    select p.id as uid, p.lg, p.place::int as place, l.name,
           case p.place when 1 then l.reward_1 when 2 then l.reward_2 else l.reward_3 end as amount
    from p join leagues l on l.id = p.lg
    where p.place <= 3
    order by p.id
  loop
    continue when r.amount <= 0;
    update users set balance = balance + r.amount where id = r.uid returning balance into v_bal;
    insert into ledger (user_id, amount, balance_after, reason) values (r.uid, r.amount, v_bal, 'league_reward');
    insert into league_payouts (week_start, league_id, place, user_id, amount) values (v_week, r.lg, r.place, r.uid, r.amount);
    insert into notices (user_id, kind, amount, title, body)
    values (r.uid, 'league_reward', r.amount, 'Лига «' || r.name || '»', r.place || ' место за неделю');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ---------- 8. Состояние главного экрана одним вызовом ----------
create or replace function game_state(p_user bigint)
returns table (balance bigint, tap_level int, tap_power bigint, tap_cost bigint, tap_max int,
               streak_days int, streak_claimed_today boolean, streak_next int, streak_rewards jsonb,
               steal_charges int, steal_price bigint, steal_max int, bonus_spins int, peak_balance bigint)
language plpgsql stable security definer set search_path = public as $$
declare
  v_today date := (clock_timestamp() at time zone 'utc')::date;
  v_last  date;
  v_count int;
  v_len   int;
begin
  select u.balance, u.tap_level, u.steal_charges, u.bonus_spins, u.peak_balance
  into balance, tap_level, steal_charges, bonus_spins, peak_balance
  from users u where u.id = p_user;
  if not found then raise exception 'user_not_found'; end if;

  tap_power := tap_power(tap_level);
  tap_cost  := tap_upgrade_cost(tap_level);
  tap_max   := tap_max_level();

  select s.day_count, s.last_claim into v_count, v_last from streaks s where s.user_id = p_user;
  streak_rewards := streak_rewards();
  v_len := greatest(jsonb_array_length(streak_rewards), 1);
  streak_claimed_today := v_last = v_today;
  -- Стрик жив, если награду брали сегодня или вчера; иначе он сгорел и начнётся с первого дня.
  streak_days := case when v_last >= v_today - 1 then v_count else 0 end;
  streak_claimed_today := coalesce(streak_claimed_today, false);
  streak_next := streak_days % v_len;   -- индекс награды, которую даст следующий заход

  steal_price := steal_price();
  steal_max   := steal_max_charges();
  return next;
end;
$$;

-- ---------- Права: вызывать функции может только наш бэкенд (service_role) ----------
revoke all on function setting_num(text, numeric), setting_json(text, jsonb), streak_default_rewards(),
  steal_price(), steal_max_charges(), tap_upgrade_base(), tap_upgrade_growth(), tap_max_level(),
  users_track_peak(), tap_power(int), tap_upgrade_cost(int), streak_rewards(), league_of(bigint)
  from public, anon, authenticated;
revoke all on function apply_taps(bigint, int), tap_upgrade(bigint), streak_claim(bigint), wheel_state(bigint),
  wheel_spin(bigint, text), steal_player(bigint, bigint), steal_buy(bigint), steal_gift(bigint, bigint),
  leaderboard_view(bigint, int), league_settle(), game_state(bigint)
  from public, anon, authenticated;
grant execute on function apply_taps(bigint, int), tap_upgrade(bigint), streak_claim(bigint), wheel_state(bigint),
  wheel_spin(bigint, text), steal_player(bigint, bigint), steal_buy(bigint), steal_gift(bigint, bigint),
  leaderboard_view(bigint, int), league_settle(), game_state(bigint)
  to service_role;

notify pgrst, 'reload schema';
