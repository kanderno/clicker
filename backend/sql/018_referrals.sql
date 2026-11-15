-- Этап 14: реферальная система. Выполнить целиком в Supabase -> SQL Editor.
--
-- Правила:
--  * у каждого игрока своя ссылка t.me/<бот>?start=ref_<id>; кто пришёл по ней, тот его приглашённый;
--  * засчитывается только НОВЫЙ человек: если он уже был в игре, ссылка ничего не даёт
--    (иначе друзья приглашали бы друг друга по кругу);
--  * награда пригласившему — referral_bonus монет (настройка админа, по умолчанию 5000),
--    начисляется, когда приглашённый впервые открыл игру; один человек засчитывается один раз;
--  * начисление идёт через ledger (reason 'referral'), пригласивший видит уведомление.

create table if not exists referrals (
  id           bigint generated always as identity primary key,
  referrer_id  bigint not null references users(id),
  referred_tg  bigint not null unique,                 -- Telegram ID приглашённого (до входа в игру его ещё нет в users)
  referred_id  bigint unique references users(id),     -- заполняется, когда приглашённый вошёл в игру
  bonus        bigint not null default 0,              -- сколько получил пригласивший
  created_at   timestamptz not null default now(),
  rewarded_at  timestamptz
);
create index if not exists referrals_referrer_idx on referrals (referrer_id, rewarded_at desc);
alter table referrals enable row level security;

create or replace function referral_bonus() returns bigint language sql stable as $$
  select greatest(setting_num('referral_bonus', 5000), 0)::bigint $$;

-- Человек перешёл по ссылке пригласившего (до первого входа в игру). Возвращает true, если переход записан.
-- Уже существующие игроки и переход по своей же ссылке не записываются.
create or replace function referral_invite(p_referrer bigint, p_referred_tg bigint)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_ref_tg bigint;
begin
  if p_referrer is null or p_referred_tg is null then return false; end if;
  select u.telegram_id into v_ref_tg from users u where u.id = p_referrer;
  if not found or v_ref_tg = p_referred_tg then return false; end if;
  if exists (select 1 from users u where u.telegram_id = p_referred_tg) then return false; end if;

  insert into referrals (referrer_id, referred_tg) values (p_referrer, p_referred_tg)
  on conflict (referred_tg) do nothing;
  return found;
end;
$$;

-- Приглашённый впервые вошёл в игру: пригласивший получает награду. Повторный вызов ничего не делает.
create or replace function referral_claim(p_user bigint)
returns table (referrer_id bigint, bonus bigint)
language plpgsql security definer set search_path = public as $$
declare
  v_tg      bigint;
  v_created timestamptz;
  v_name    text;
  v_ref     referrals%rowtype;
  v_bonus   bigint := referral_bonus();
  v_balance bigint;
begin
  select u.telegram_id, u.created_at, coalesce('@' || u.username, u.first_name, 'Игрок')
  into v_tg, v_created, v_name from users u where u.id = p_user;
  if not found then raise exception 'user_not_found'; end if;

  select * into v_ref from referrals r where r.referred_tg = v_tg and r.referred_id is null for update;
  if not found then return; end if;
  -- Игрок появился раньше перехода по ссылке: он не новый, награды нет.
  if v_created < v_ref.created_at - interval '1 minute' then return; end if;

  update referrals set referred_id = p_user, bonus = v_bonus, rewarded_at = clock_timestamp() where id = v_ref.id;

  if v_bonus > 0 then
    update users u set balance = u.balance + v_bonus where u.id = v_ref.referrer_id returning u.balance into v_balance;
    insert into ledger (user_id, amount, balance_after, reason) values (v_ref.referrer_id, v_bonus, v_balance, 'referral');
  end if;
  insert into notices (user_id, kind, amount, title, body)
  values (v_ref.referrer_id, 'referral', v_bonus, v_name, 'по твоей ссылке');

  referrer_id := v_ref.referrer_id;
  bonus := v_bonus;
  return next;
end;
$$;

-- Экран «Друзья»: сколько пригласил, сколько заработал, сколько дают за друга.
create or replace function referral_state(p_user bigint)
returns table (invited int, earned bigint, bonus bigint)
language sql stable security definer set search_path = public as $$
  select count(*)::int, coalesce(sum(r.bonus), 0)::bigint, referral_bonus()
  from referrals r where r.referrer_id = p_user and r.referred_id is not null
$$;

revoke all on function referral_bonus() from public, anon, authenticated;
revoke all on function referral_invite(bigint, bigint), referral_claim(bigint), referral_state(bigint)
  from public, anon, authenticated;
grant execute on function referral_invite(bigint, bigint), referral_claim(bigint), referral_state(bigint) to service_role;

notify pgrst, 'reload schema';
