-- Этап 3: банк. Выполнить целиком в Supabase -> SQL Editor.
-- Проценты считаются "при чтении": никаких cron-задач, формула principal * (1 + rate)^часы.

create table if not exists savings (
  user_id     bigint primary key references users(id),
  principal   numeric(24,6) not null default 0 check (principal >= 0),
  last_update timestamptz   not null default now()
);
alter table savings enable row level security;

-- Параметры банка (меняются только здесь, в одном месте).
create or replace function bank_rate() returns numeric
language sql immutable as $$ select 0.002::numeric $$;          -- 0.2% в час

create or replace function bank_max_hours() returns int
language sql immutable as $$ select 168 $$;                      -- проценты копятся максимум 7 суток

-- Сумма вклада с учётом сложных процентов на момент p_now.
create or replace function savings_grow(p_principal numeric, p_last timestamptz, p_now timestamptz)
returns numeric
language sql stable as $$
  select p_principal * power(
    1 + bank_rate(),
    least(greatest(extract(epoch from (p_now - p_last))::numeric / 3600, 0), bank_max_hours()::numeric)
  )
$$;

-- Только чтение: состояние банка (ничего не записывает).
create or replace function bank_state(p_user bigint)
returns table (wallet_balance bigint, savings_balance bigint, hourly_gain bigint, rate_per_hour numeric, max_hours int)
language plpgsql stable security definer set search_path = public
as $$
declare
  v_balance   bigint;
  v_principal numeric;
  v_last      timestamptz;
  v_cur       numeric := 0;
begin
  select u.balance into v_balance from users u where u.id = p_user;
  if not found then raise exception 'user_not_found'; end if;

  select s.principal, s.last_update into v_principal, v_last from savings s where s.user_id = p_user;
  if found then
    v_cur := savings_grow(v_principal, v_last, clock_timestamp());
  end if;

  wallet_balance  := v_balance;
  savings_balance := floor(v_cur)::bigint;
  hourly_gain     := floor(v_cur * bank_rate())::bigint;
  rate_per_hour   := bank_rate();
  max_hours       := bank_max_hours();
  return next;
end;
$$;

-- Положить на счёт: сначала капитализация процентов, потом списание из кошелька.
create or replace function bank_deposit(p_user bigint, p_amount bigint)
returns table (wallet_balance bigint, savings_balance bigint)
language plpgsql security definer set search_path = public
as $$
declare
  v_now       timestamptz := clock_timestamp();
  v_balance   bigint;
  v_principal numeric;
  v_last      timestamptz;
  v_cur       numeric := 0;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'bad_amount'; end if;

  -- порядок блокировок всегда: users -> savings (чтобы не было взаимных блокировок)
  select u.balance into v_balance from users u where u.id = p_user for update;
  if not found then raise exception 'user_not_found'; end if;
  if v_balance < p_amount then raise exception 'insufficient_funds'; end if;

  select s.principal, s.last_update into v_principal, v_last
  from savings s where s.user_id = p_user for update;
  if found then
    v_cur := savings_grow(v_principal, v_last, v_now);
  end if;
  v_cur := v_cur + p_amount;

  insert into savings (user_id, principal, last_update) values (p_user, v_cur, v_now)
  on conflict (user_id) do update set principal = excluded.principal, last_update = excluded.last_update;

  v_balance := v_balance - p_amount;
  update users set balance = v_balance where id = p_user;
  insert into ledger (user_id, amount, balance_after, reason)
  values (p_user, -p_amount, v_balance, 'bank_deposit');

  wallet_balance  := v_balance;
  savings_balance := floor(v_cur)::bigint;
  return next;
end;
$$;

-- Снять со счёта: сначала капитализация процентов, потом зачисление в кошелёк.
create or replace function bank_withdraw(p_user bigint, p_amount bigint)
returns table (wallet_balance bigint, savings_balance bigint)
language plpgsql security definer set search_path = public
as $$
declare
  v_now       timestamptz := clock_timestamp();
  v_balance   bigint;
  v_principal numeric;
  v_last      timestamptz;
  v_cur       numeric;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'bad_amount'; end if;

  select u.balance into v_balance from users u where u.id = p_user for update;
  if not found then raise exception 'user_not_found'; end if;

  select s.principal, s.last_update into v_principal, v_last
  from savings s where s.user_id = p_user for update;
  if not found then raise exception 'insufficient_funds'; end if;

  v_cur := savings_grow(v_principal, v_last, v_now);
  if floor(v_cur) < p_amount then raise exception 'insufficient_funds'; end if;
  v_cur := v_cur - p_amount;

  update savings set principal = v_cur, last_update = v_now where user_id = p_user;

  v_balance := v_balance + p_amount;
  update users set balance = v_balance where id = p_user;
  insert into ledger (user_id, amount, balance_after, reason)
  values (p_user, p_amount, v_balance, 'bank_withdraw');

  wallet_balance  := v_balance;
  savings_balance := floor(v_cur)::bigint;
  return next;
end;
$$;

-- Доступ только у нашего бэкенда.
revoke all on function bank_rate(), bank_max_hours(), savings_grow(numeric, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function bank_state(bigint), bank_deposit(bigint, bigint), bank_withdraw(bigint, bigint) from public, anon, authenticated;
grant execute on function bank_state(bigint), bank_deposit(bigint, bigint), bank_withdraw(bigint, bigint) to service_role;

notify pgrst, 'reload schema';
