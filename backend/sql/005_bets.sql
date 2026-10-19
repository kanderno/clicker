-- Этап 4b: ставки. Выполнить в Supabase -> SQL Editor.

-- Одна ставка на игрока в событии (можно докидывать монет на тот же вариант).
create unique index if not exists bets_user_event_uidx on bets (user_id, event_id);

create or replace function place_bet(p_user bigint, p_event bigint, p_option bigint, p_amount bigint)
returns table (new_balance bigint, my_stake bigint, option_pool bigint)
language plpgsql security definer set search_path = public
as $$
declare
  v_status   text;
  v_deadline timestamptz;
  v_balance  bigint;
  v_cur_opt  bigint;
  v_cur_amt  bigint;
  v_stake    bigint;
  v_pool     bigint;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'bad_amount'; end if;

  -- Порядок блокировок: событие -> игрок -> ставка -> вариант.
  -- FOR SHARE на событии: при закрытии события (этап 4c, FOR UPDATE) новая ставка не проскочит.
  select e.status, e.deadline into v_status, v_deadline
  from events e where e.id = p_event for share;
  if not found then raise exception 'event_not_found'; end if;
  if v_status <> 'open' or clock_timestamp() >= v_deadline then raise exception 'event_closed'; end if;

  if not exists (select 1 from event_options o where o.id = p_option and o.event_id = p_event) then
    raise exception 'bad_option';
  end if;

  select u.balance into v_balance from users u where u.id = p_user for update;
  if not found then raise exception 'user_not_found'; end if;
  if v_balance < p_amount then raise exception 'insufficient_funds'; end if;

  select b.option_id, b.amount into v_cur_opt, v_cur_amt
  from bets b where b.user_id = p_user and b.event_id = p_event for update;

  if found then
    if v_cur_opt <> p_option then raise exception 'other_option'; end if;
    v_stake := v_cur_amt + p_amount;
    update bets set amount = v_stake where user_id = p_user and event_id = p_event;
  else
    v_stake := p_amount;
    insert into bets (user_id, event_id, option_id, amount) values (p_user, p_event, p_option, p_amount);
  end if;

  v_balance := v_balance - p_amount;
  update users set balance = v_balance where id = p_user;
  insert into ledger (user_id, amount, balance_after, reason) values (p_user, -p_amount, v_balance, 'bet');

  update event_options set pool = pool + p_amount where id = p_option returning pool into v_pool;

  new_balance := v_balance;
  my_stake    := v_stake;
  option_pool := v_pool;
  return next;
end;
$$;

revoke all on function place_bet(bigint, bigint, bigint, bigint) from public, anon, authenticated;
grant execute on function place_bet(bigint, bigint, bigint, bigint) to service_role;

notify pgrst, 'reload schema';
