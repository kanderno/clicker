-- Этап 4c: закрытие события, выплаты, возвраты. Выполнить в Supabase -> SQL Editor.

alter table events add column if not exists refunded boolean not null default false;

-- Закрыть событие с победителем (p_option) или отменить его (p_option = null).
--  * победитель, на которого ставили: выплата = ставка / сумма ставок победителей * весь пул;
--    остаток от округления раздаётся по одной монете (у кого дробная часть больше), итог ровно равен пулу;
--  * на победителя никто не ставил, либо отмена: всем возвращаются их ставки;
--  * повторный вызов ничего не меняет (changed = false).
create or replace function admin_resolve_event(p_event bigint, p_option bigint)
returns table (res_changed boolean, res_status text, res_refunded boolean, res_total bigint, res_paid bigint)
language plpgsql security definer set search_path = public
as $$
declare
  v_status    text;
  v_refunded  boolean;
  v_total     bigint;
  v_win_total bigint := 0;
  v_refund    boolean;
  v_paid      bigint;
begin
  -- Порядок блокировок: событие -> игроки (по возрастанию id). Как и в place_bet: сначала событие.
  -- FOR UPDATE дожидается уже идущих ставок (они держат FOR SHARE); новые увидят статус и получат отказ.
  select e.status, e.refunded into v_status, v_refunded from events e where e.id = p_event for update;
  if not found then raise exception 'event_not_found'; end if;

  select coalesce(sum(b.amount), 0) into v_total from bets b where b.event_id = p_event;

  if v_status <> 'open' then
    res_changed := false; res_status := v_status; res_refunded := v_refunded; res_total := v_total;
    select coalesce(sum(b.payout), 0) into res_paid from bets b where b.event_id = p_event;
    return next;
    return;
  end if;

  if p_option is not null and not exists (
    select 1 from event_options o where o.id = p_option and o.event_id = p_event
  ) then
    raise exception 'bad_option';
  end if;

  if p_option is not null then
    select coalesce(sum(b.amount), 0) into v_win_total
    from bets b where b.event_id = p_event and b.option_id = p_option;
  end if;

  v_refund := p_option is null or v_win_total = 0;

  if v_refund then
    -- Возврат всех ставок
    update bets set payout = amount where event_id = p_event;
    perform 1 from users u where u.id in (select b.user_id from bets b where b.event_id = p_event)
      order by u.id for update;
    with upd as (
      update users u set balance = u.balance + b.payout
      from bets b where b.event_id = p_event and b.user_id = u.id
      returning u.id as uid, b.payout as amt, u.balance as bal
    )
    insert into ledger (user_id, amount, balance_after, reason)
    select uid, amt, bal, 'bet_refund' from upd;
  else
    -- Пропорциональная выплата с раздачей остатка по методу наибольших остатков
    with w as (
      select b.id,
             floor(b.amount::numeric * v_total / v_win_total) as base,
             (b.amount::numeric * v_total) % v_win_total      as rem
      from bets b where b.event_id = p_event and b.option_id = p_option
    ), r as (
      select w.id, w.base,
             row_number() over (order by w.rem desc, w.id) as rn,
             v_total - sum(w.base) over ()                 as leftover
      from w
    )
    update bets b
       set payout = (r.base + case when r.rn <= r.leftover then 1 else 0 end)::bigint
      from r where b.id = r.id;

    update bets set payout = 0 where event_id = p_event and option_id <> p_option;

    perform 1 from users u where u.id in (select b.user_id from bets b where b.event_id = p_event and b.payout > 0)
      order by u.id for update;
    with upd as (
      update users u set balance = u.balance + b.payout
      from bets b where b.event_id = p_event and b.user_id = u.id and b.payout > 0
      returning u.id as uid, b.payout as amt, u.balance as bal
    )
    insert into ledger (user_id, amount, balance_after, reason)
    select uid, amt, bal, 'bet_win' from upd;
  end if;

  -- Страховка: выплачено ровно столько, сколько в пуле. Иначе вся операция откатывается.
  select coalesce(sum(b.payout), 0) into v_paid from bets b where b.event_id = p_event;
  if v_paid <> v_total then raise exception 'payout_mismatch'; end if;

  update events
     set status = case when p_option is null then 'cancelled' else 'resolved' end,
         winning_option_id = p_option,
         refunded = v_refund,
         resolved_at = now()
   where id = p_event;

  res_changed := true;
  res_status := case when p_option is null then 'cancelled' else 'resolved' end;
  res_refunded := v_refund;
  res_total := v_total;
  res_paid := v_paid;
  return next;
end;
$$;

revoke all on function admin_resolve_event(bigint, bigint) from public, anon, authenticated;
grant execute on function admin_resolve_event(bigint, bigint) to service_role;

notify pgrst, 'reload schema';
