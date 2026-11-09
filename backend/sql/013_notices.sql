-- Этап 9: уведомления игрокам (результаты ставок и другие события). Выполнить целиком в Supabase -> SQL Editor.
--
-- Правила:
--  * notices — общий журнал уведомлений: игрок видит их один раз, потом помечает прочитанными;
--  * когда событие закрывается (status: open -> resolved/cancelled), триггер пишет уведомление
--    каждому, кто ставил: выигрыш (+выплата), проигрыш (-свои монеты) или возврат;
--  * функцию закрытия события это не меняет: триггер срабатывает в той же транзакции,
--    когда выплаты уже посчитаны.

create table if not exists notices (
  id         bigint generated always as identity primary key,
  user_id    bigint not null references users(id),
  kind       text   not null,                 -- 'bet_win', 'bet_lost', 'bet_refund', ...
  amount     bigint not null default 0,       -- сумма для показа (всегда >= 0, знак задаёт kind)
  title      text,
  body       text,
  seen       boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists notices_unseen_idx on notices (user_id) where not seen;
alter table notices enable row level security;

create or replace function notify_bet_results() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if old.status = 'open' and new.status <> 'open' then
    insert into notices (user_id, kind, amount, title, body)
    select b.user_id,
           case
             when new.status = 'cancelled' or new.refunded then 'bet_refund'
             when coalesce(b.payout, 0) > 0 then 'bet_win'
             else 'bet_lost'
           end,
           case
             when new.status = 'cancelled' or new.refunded then coalesce(b.payout, 0)
             when coalesce(b.payout, 0) > 0 then b.payout
             else b.amount - b.free_amount
           end,
           new.title,
           o.title
    from bets b
    join event_options o on o.id = b.option_id
    where b.event_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists events_notify_results on events;
create trigger events_notify_results
  after update of status on events
  for each row execute function notify_bet_results();

revoke all on function notify_bet_results() from public, anon, authenticated;

notify pgrst, 'reload schema';
