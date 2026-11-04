-- Этап 8: переводы монет между игроками. Выполнить целиком в Supabase -> SQL Editor.
--
-- Правила:
--  * переводятся только монеты из КОШЕЛЬКА (balance), сберегательный счёт не трогается;
--  * себе переводить нельзя, сумма — целое число от 1;
--  * не больше transfer_daily_max() переводов в сутки от одного игрока (защита от спама);
--  * списание у отправителя и зачисление получателю — одна транзакция, обе стороны в ledger;
--  * получатель видит уведомление (seen = false), отправитель — в истории.

create table if not exists transfers (
  id            bigint generated always as identity primary key,
  from_id       bigint not null references users(id),
  to_id         bigint not null references users(id),
  amount        bigint not null check (amount > 0),
  comment       text check (comment is null or char_length(comment) <= 100),
  seen          boolean not null default false,       -- получатель уже увидел уведомление
  created_at    timestamptz not null default now(),
  check (from_id <> to_id)
);
create index if not exists transfers_from_idx on transfers (from_id, created_at desc);
create index if not exists transfers_to_idx on transfers (to_id, created_at desc);
create index if not exists transfers_unseen_idx on transfers (to_id) where not seen;
alter table transfers enable row level security;

-- Параметры переводов
create or replace function transfer_daily_max() returns int    language sql immutable as $$ select 30 $$;
create or replace function transfer_max()       returns bigint language sql immutable as $$ select 1000000000000::bigint $$;

create or replace function transfer_coins(p_from bigint, p_to bigint, p_amount bigint, p_comment text default null)
returns table (new_balance bigint, transfer_id bigint)
language plpgsql security definer set search_path = public
as $$
declare
  v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
  v_balance bigint;
  v_to_bal  bigint;
  v_count   int;
  v_id      bigint;
begin
  if p_amount is null or p_amount <= 0 or p_amount > transfer_max() then raise exception 'bad_amount'; end if;
  if p_from = p_to then raise exception 'self_transfer'; end if;
  if v_comment is not null and char_length(v_comment) > 100 then raise exception 'bad_comment'; end if;

  -- Блокируем обоих игроков всегда по возрастанию id: встречные переводы A->B и B->A не дадут deadlock.
  perform 1 from users u where u.id in (p_from, p_to) order by u.id for update;

  select u.balance into v_balance from users u where u.id = p_from;
  if not found then raise exception 'user_not_found'; end if;
  select u.balance into v_to_bal from users u where u.id = p_to;
  if not found then raise exception 'recipient_not_found'; end if;

  -- Счёт под блокировкой отправителя: параллельные запросы не обойдут лимит.
  select count(*)::int into v_count from transfers t
  where t.from_id = p_from and t.created_at > clock_timestamp() - interval '24 hours';
  if v_count >= transfer_daily_max() then raise exception 'daily_limit'; end if;

  if v_balance < p_amount then raise exception 'insufficient_funds'; end if;

  v_balance := v_balance - p_amount;
  update users set balance = v_balance where id = p_from;
  insert into ledger (user_id, amount, balance_after, reason) values (p_from, -p_amount, v_balance, 'transfer_out');

  v_to_bal := v_to_bal + p_amount;
  update users set balance = v_to_bal where id = p_to;
  insert into ledger (user_id, amount, balance_after, reason) values (p_to, p_amount, v_to_bal, 'transfer_in');

  insert into transfers (from_id, to_id, amount, comment) values (p_from, p_to, p_amount, v_comment)
  returning id into v_id;

  new_balance := v_balance;
  transfer_id := v_id;
  return next;
end;
$$;

revoke all on function transfer_daily_max(), transfer_max() from public, anon, authenticated;
revoke all on function transfer_coins(bigint, bigint, bigint, text) from public, anon, authenticated;
grant execute on function transfer_coins(bigint, bigint, bigint, text) to service_role;

notify pgrst, 'reload schema';
