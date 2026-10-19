-- Этап 2: кликер. Выполнить целиком в Supabase -> SQL Editor.

alter table users add column if not exists last_tap_at timestamptz;

-- Журнал всех изменений монет. Любое начисление/списание пишется сюда.
create table if not exists ledger (
  id            bigint generated always as identity primary key,
  user_id       bigint not null references users(id),
  amount        bigint not null,           -- + начисление, - списание
  balance_after bigint not null,
  reason        text   not null,           -- 'tap', 'bet', 'spin', ...
  created_at    timestamptz not null default now()
);
create index if not exists ledger_user_created_idx on ledger (user_id, created_at desc);
alter table ledger enable row level security;

-- Атомарное начисление тапов с лимитом 15 кликов/сек.
create or replace function apply_taps(p_user bigint, p_count int)
returns table (new_balance bigint, accepted int)
language plpgsql
security definer
set search_path = public
as $$
declare
  c_rate          constant int     := 15;   -- макс. кликов в секунду
  c_max_elapsed   constant numeric := 30;   -- больше 30 сек "копить" нельзя
  c_first_elapsed constant numeric := 10;   -- для самого первого запроса
  v_last    timestamptz;
  v_balance bigint;
  v_now     timestamptz := clock_timestamp();
  v_elapsed numeric;
  v_allowed int;
begin
  if p_count is null or p_count <= 0 then
    raise exception 'bad_count';
  end if;

  -- блокируем строку игрока: параллельные запросы выстроятся в очередь
  select u.balance, u.last_tap_at into v_balance, v_last
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

  v_balance := v_balance + v_allowed;
  update users set balance = v_balance, last_tap_at = v_now where id = p_user;
  insert into ledger (user_id, amount, balance_after, reason)
  values (p_user, v_allowed, v_balance, 'tap');

  new_balance := v_balance;
  accepted := v_allowed;
  return next;
end;
$$;

-- Функцию может вызывать только наш бэкенд (service_role), но не браузер.
revoke all on function apply_taps(bigint, int) from public, anon, authenticated;
grant execute on function apply_taps(bigint, int) to service_role;

notify pgrst, 'reload schema';
