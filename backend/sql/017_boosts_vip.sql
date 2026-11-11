-- Этап 13: бусты и привилегии за стрик, настраиваемые защиты от краж. Выполнить целиком в Supabase -> SQL Editor.
--
--  * Буст удара: на время монет за тап становится больше (множитель tap_boost_mult, по умолчанию x2).
--  * Привилегия VIP: на время скидка на платный спин колеса (vip_wheel_discount %, по умолчанию 50)
--    и корона рядом с ником в лидерборде.
--  * Обе награды выдаются за дни стрика: в награде дня ключи boost (минут) и vip (часов).
--    Повторная награда продлевает действующий срок, а не сгорает.
--  * Защиты от краж теперь в настройках: steal_newbie_hours (0 — новичков не защищать),
--    steal_victim_cap (0 — без лимита краж у одного игрока в сутки), steal_min_balance.

alter table users add column if not exists tap_boost_until timestamptz;
alter table users add column if not exists vip_until       timestamptz;

create or replace function tap_boost_mult() returns int language sql stable as $$
  select greatest(setting_num('tap_boost_mult', 2), 1)::int $$;
create or replace function vip_wheel_discount() returns int language sql stable as $$
  select least(greatest(setting_num('vip_wheel_discount', 50), 0), 100)::int $$;

create or replace function steal_min_balance() returns bigint language sql stable as $$
  select setting_num('steal_min_balance', 100)::bigint $$;
create or replace function steal_newbie_hours() returns int language sql stable as $$
  select setting_num('steal_newbie_hours', 24)::int $$;
create or replace function steal_victim_cap() returns int language sql stable as $$
  select case when setting_num('steal_victim_cap', 3) <= 0 then 1000000 else setting_num('steal_victim_cap', 3)::int end $$;

-- Новые награды по умолчанию (если админ ещё не менял стрик): буст на 5-й день, VIP на 7-й.
create or replace function streak_default_rewards() returns jsonb language sql immutable as $$
  select '[{"coins":100},{"coins":250},{"spins":1},{"coins":500},{"coins":1000,"boost":30},{"coins":1500,"spins":1},{"coins":3000,"steals":1,"vip":24}]'::jsonb
$$;

-- Монет за тап с учётом буста
create or replace function tap_value(p_level int, p_boost_until timestamptz) returns bigint language sql stable as $$
  select tap_power(p_level) * case when p_boost_until > clock_timestamp() then tap_boost_mult() else 1 end
$$;

-- Цена платного спина для игрока (VIP — со скидкой)
create or replace function wheel_price_for(p_vip_until timestamptz) returns bigint language sql stable as $$
  select case when p_vip_until > clock_timestamp()
              then greatest(ceil(wheel_price() * (100 - vip_wheel_discount()) / 100.0), 0)::bigint
              else wheel_price() end
$$;

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
  v_boost   timestamptz;
  v_now     timestamptz := clock_timestamp();
  v_elapsed numeric;
  v_allowed int;
  v_coins   bigint;
begin
  if p_count is null or p_count <= 0 then
    raise exception 'bad_count';
  end if;

  select u.balance, u.last_tap_at, u.tap_level, u.tap_boost_until into v_balance, v_last, v_level, v_boost
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

  v_coins := v_allowed * tap_value(v_level, v_boost);
  v_balance := v_balance + v_coins;
  update users set balance = v_balance, last_tap_at = v_now where id = p_user;
  insert into ledger (user_id, amount, balance_after, reason)
  values (p_user, v_coins, v_balance, 'tap');

  new_balance := v_balance;
  accepted := v_allowed;
  return next;
end;
$$;

-- Стрик: теперь ещё буст (минут) и VIP (часов). Возвращаемые поля меняются, поэтому функция пересоздаётся.
drop function if exists streak_claim(bigint);
create or replace function streak_claim(p_user bigint)
returns table (day_count int, coins bigint, spins int, steals int, boost_minutes int, vip_hours int, new_balance bigint)
language plpgsql security definer set search_path = public as $$
declare
  v_today   date := (clock_timestamp() at time zone 'utc')::date;
  v_now     timestamptz := clock_timestamp();
  v_last    date;
  v_count   int;
  v_rewards jsonb := streak_rewards();
  v_len     int;
  v_reward  jsonb;
  v_coins   bigint;
  v_spins   int;
  v_steals  int;
  v_boost   int;
  v_vip     int;
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
  v_boost  := greatest(coalesce((v_reward ->> 'boost')::int, 0), 0);
  v_vip    := greatest(coalesce((v_reward ->> 'vip')::int, 0), 0);

  insert into streaks (user_id, day_count, last_claim) values (p_user, v_count, v_today)
  on conflict (user_id) do update set day_count = excluded.day_count, last_claim = excluded.last_claim;

  v_balance := v_balance + v_coins;
  update users u set
    balance = v_balance,
    bonus_spins = u.bonus_spins + v_spins,
    steal_charges = least(u.steal_charges + v_steals, greatest(steal_max_charges(), u.steal_charges)),
    tap_boost_until = case when v_boost > 0
      then greatest(coalesce(u.tap_boost_until, v_now), v_now) + make_interval(mins => v_boost)
      else u.tap_boost_until end,
    vip_until = case when v_vip > 0
      then greatest(coalesce(u.vip_until, v_now), v_now) + make_interval(hours => v_vip)
      else u.vip_until end
  where u.id = p_user;
  if v_coins > 0 then
    insert into ledger (user_id, amount, balance_after, reason) values (p_user, v_coins, v_balance, 'streak');
  end if;

  day_count := v_count; coins := v_coins; spins := v_spins; steals := v_steals;
  boost_minutes := v_boost; vip_hours := v_vip; new_balance := v_balance;
  return next;
end;
$$;

-- Состояние главного экрана: плюс буст и VIP.
drop function if exists game_state(bigint);
create or replace function game_state(p_user bigint)
returns table (balance bigint, tap_level int, tap_power bigint, tap_cost bigint, tap_max int,
               streak_days int, streak_claimed_today boolean, streak_next int, streak_rewards jsonb,
               steal_charges int, steal_price bigint, steal_max int, bonus_spins int, peak_balance bigint,
               boost_until timestamptz, boost_mult int, vip_until timestamptz, vip_discount int)
language plpgsql stable security definer set search_path = public as $$
declare
  v_today date := (clock_timestamp() at time zone 'utc')::date;
  v_last  date;
  v_count int;
  v_len   int;
begin
  select u.balance, u.tap_level, u.steal_charges, u.bonus_spins, u.peak_balance, u.tap_boost_until, u.vip_until
  into balance, tap_level, steal_charges, bonus_spins, peak_balance, boost_until, vip_until
  from users u where u.id = p_user;
  if not found then raise exception 'user_not_found'; end if;

  tap_power := tap_value(tap_level, boost_until);   -- монет за тап прямо сейчас (с бустом)
  tap_cost  := tap_upgrade_cost(tap_level);
  tap_max   := tap_max_level();
  if boost_until <= clock_timestamp() then boost_until := null; end if;
  if vip_until <= clock_timestamp() then vip_until := null; end if;
  boost_mult := tap_boost_mult();
  vip_discount := vip_wheel_discount();

  select s.day_count, s.last_claim into v_count, v_last from streaks s where s.user_id = p_user;
  streak_rewards := streak_rewards();
  v_len := greatest(jsonb_array_length(streak_rewards), 1);
  streak_claimed_today := coalesce(v_last = v_today, false);
  streak_days := case when v_last >= v_today - 1 then v_count else 0 end;
  streak_next := streak_days % v_len;

  steal_price := steal_price();
  steal_max   := steal_max_charges();
  return next;
end;
$$;

-- Колесо: цена платного спина с учётом VIP.
drop function if exists wheel_state(bigint);
create or replace function wheel_state(p_user bigint)
returns table (free_available boolean, paid_today int, paid_max int, price bigint, seconds_to_reset int,
               bonus_spins int, steal_charges int, base_price bigint, vip_until timestamptz)
language plpgsql security definer set search_path = public
as $$
declare
  v_day date := (clock_timestamp() at time zone 'utc')::date;
begin
  select u.bonus_spins, u.steal_charges, u.vip_until into bonus_spins, steal_charges, vip_until
  from users u where u.id = p_user;
  if not found then raise exception 'user_not_found'; end if;

  free_available := not exists (select 1 from spins s where s.user_id = p_user and s.spin_day = v_day and not s.paid);
  select count(*)::int into paid_today from spins s
  where s.user_id = p_user and s.spin_day = v_day and s.paid and not s.bonus;
  paid_max := wheel_max_paid();
  price := wheel_price_for(vip_until);
  base_price := wheel_price();
  if vip_until <= clock_timestamp() then vip_until := null; end if;
  seconds_to_reset := floor(extract(epoch from ((v_day + 1)::timestamp - (clock_timestamp() at time zone 'utc'))))::int;
  return next;
end;
$$;

create or replace function wheel_spin(p_user bigint, p_mode text)
returns table (prize_id bigint, prize_label text, prize_kind text, prize_value bigint, new_balance bigint, was_free boolean)
language plpgsql security definer set search_path = public
as $$
declare
  v_day     date := (clock_timestamp() at time zone 'utc')::date;
  v_balance bigint;
  v_bonus   int;
  v_charges int;
  v_vip     timestamptz;
  v_price   bigint;
  v_paid    int;
  v_prize   prizes%rowtype;
  v_pick    bigint;
begin
  if p_mode is null or p_mode not in ('free', 'paid', 'bonus') then raise exception 'bad_mode'; end if;

  select u.balance, u.bonus_spins, u.steal_charges, u.vip_until into v_balance, v_bonus, v_charges, v_vip
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
    v_price := wheel_price_for(v_vip);
    if v_balance < v_price then raise exception 'insufficient_funds'; end if;
    if v_price > 0 then
      v_balance := v_balance - v_price;
      update users set balance = v_balance where id = p_user;
      insert into ledger (user_id, amount, balance_after, reason) values (p_user, -v_price, v_balance, 'spin_buy');
    end if;
  end if;

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

-- Лидерборд: плюс признак VIP (корона рядом с ником).
drop function if exists leaderboard_view(bigint, int);
create or replace function leaderboard_view(p_user bigint, p_limit int default 20)
returns table (scope text, place bigint, user_id bigint, username text, first_name text, photo_url text,
               balance bigint, league_id bigint, vip boolean)
language sql stable security definer set search_path = public as $$
  with ranked as (
    select u.id, u.username, u.first_name, u.photo_url, u.balance, league_of(u.peak_balance) as lg,
           coalesce(u.vip_until > clock_timestamp(), false) as vip
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
  select g.scope, g.place, g.id, g.username, g.first_name, g.photo_url, g.balance, g.lg, g.vip
  from g where g.place <= p_limit or g.id = p_user
  union all
  select l.scope, l.place, l.id, l.username, l.first_name, l.photo_url, l.balance, l.lg, l.vip
  from l where l.place <= p_limit or l.id = p_user
$$;

revoke all on function tap_boost_mult(), vip_wheel_discount(), tap_value(int, timestamptz),
  wheel_price_for(timestamptz) from public, anon, authenticated;
revoke all on function apply_taps(bigint, int), streak_claim(bigint), game_state(bigint), wheel_state(bigint),
  wheel_spin(bigint, text), leaderboard_view(bigint, int) from public, anon, authenticated;
grant execute on function apply_taps(bigint, int), streak_claim(bigint), game_state(bigint), wheel_state(bigint),
  wheel_spin(bigint, text), leaderboard_view(bigint, int) to service_role;

notify pgrst, 'reload schema';
