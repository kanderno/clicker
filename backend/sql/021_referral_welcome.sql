-- Этап 17: бонус по реферальной ссылке получает не только пригласивший, но и новичок.
-- Выполнить целиком в Supabase -> SQL Editor (после 018_referrals.sql).
--
-- Правила:
--  * пригласивший, как и раньше, получает referral_bonus монет (по умолчанию 5000);
--  * новичок при первом входе получает referral_welcome_bonus монет (настройка админа, по умолчанию 2500);
--  * обе выплаты идут в одной транзакции через ledger (reason 'referral' и 'referral_welcome'),
--    оба видят уведомление; повторно ничего не начисляется.

alter table referrals add column if not exists welcome_bonus bigint not null default 0;

create or replace function referral_welcome_bonus() returns bigint language sql stable as $$
  select greatest(setting_num('referral_welcome_bonus', 2500), 0)::bigint $$;

-- Тип результата меняется (добавилось welcome), поэтому функцию пересоздаём.
drop function if exists referral_claim(bigint);
create function referral_claim(p_user bigint)
returns table (referrer_id bigint, bonus bigint, welcome bigint)
language plpgsql security definer set search_path = public as $$
declare
  v_tg       bigint;
  v_created  timestamptz;
  v_name     text;
  v_ref_name text;
  v_ref      referrals%rowtype;
  v_bonus    bigint := referral_bonus();
  v_welcome  bigint := referral_welcome_bonus();
  v_balance  bigint;
begin
  select u.telegram_id, u.created_at, coalesce('@' || u.username, u.first_name, 'Игрок')
  into v_tg, v_created, v_name from users u where u.id = p_user;
  if not found then raise exception 'user_not_found'; end if;

  select * into v_ref from referrals r where r.referred_tg = v_tg and r.referred_id is null for update;
  if not found then return; end if;
  -- Игрок появился раньше перехода по ссылке: он не новый, награды нет.
  if v_created < v_ref.created_at - interval '1 minute' then return; end if;

  select coalesce('@' || u.username, u.first_name, 'Игрок') into v_ref_name from users u where u.id = v_ref.referrer_id;

  update referrals
  set referred_id = p_user, bonus = v_bonus, welcome_bonus = v_welcome, rewarded_at = clock_timestamp()
  where id = v_ref.id;

  if v_bonus > 0 then
    update users u set balance = u.balance + v_bonus where u.id = v_ref.referrer_id returning u.balance into v_balance;
    insert into ledger (user_id, amount, balance_after, reason) values (v_ref.referrer_id, v_bonus, v_balance, 'referral');
  end if;
  insert into notices (user_id, kind, amount, title, body)
  values (v_ref.referrer_id, 'referral', v_bonus, v_name, 'по твоей ссылке');

  if v_welcome > 0 then
    update users u set balance = u.balance + v_welcome where u.id = p_user returning u.balance into v_balance;
    insert into ledger (user_id, amount, balance_after, reason) values (p_user, v_welcome, v_balance, 'referral_welcome');
    insert into notices (user_id, kind, amount, title, body)
    values (p_user, 'referral_welcome', v_welcome, v_ref_name, 'приглашение друга');
  end if;

  referrer_id := v_ref.referrer_id;
  bonus := v_bonus;
  welcome := v_welcome;
  return next;
end;
$$;

revoke all on function referral_welcome_bonus() from public, anon, authenticated;
revoke all on function referral_claim(bigint) from public, anon, authenticated;
grant execute on function referral_claim(bigint) to service_role;

notify pgrst, 'reload schema';
