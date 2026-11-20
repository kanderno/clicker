-- Этап 15: «Экология» вместо ставок и переводов. Выполнить целиком в Supabase -> SQL Editor.
--
-- Правила:
--  * игрок отправляет заявку: описание своей помощи экологии + фото/видео (до 5 файлов);
--  * файлы лежат в Supabase Storage (бакет eco-reports, закрытый), сервер выдаёт на них временные ссылки;
--  * заявку проверяет админ или модератор экологии: одобрить (с наградой) или отклонить (с причиной);
--  * награда по умолчанию — eco_reward монет (настройка админа, 1000), проверяющий может поменять её у заявки;
--  * начисление через ledger (reason 'eco'), игрок видит уведомление о решении;
--  * ждущих проверки заявок у игрока не больше 3, всего заявок в сутки не больше eco_daily_limit (5).
--  * таблицы ставок и переводов НЕ трогаем: функции просто выключены на сервере и могут вернуться.

create table if not exists eco_reports (
  id             bigint generated always as identity primary key,
  user_id        bigint not null references users(id),
  description    text   not null check (char_length(description) between 3 and 500),
  media          jsonb  not null default '[]'::jsonb,       -- [{ "path": "<user_id>/<файл>", "mime": "image/jpeg" }]
  status         text   not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reward         bigint not null default 0 check (reward >= 0),
  reviewer_tg    bigint,                                     -- Telegram ID проверившего
  reviewer_name  text,                                       -- кто проверил (показывается игроку)
  review_comment text,
  created_at     timestamptz not null default now(),
  reviewed_at    timestamptz
);
create index if not exists eco_reports_user_idx on eco_reports (user_id, created_at desc);
create index if not exists eco_reports_pending_idx on eco_reports (created_at) where status = 'pending';
alter table eco_reports enable row level security;

create or replace function eco_reward() returns bigint language sql stable as $$
  select greatest(setting_num('eco_reward', 1000), 0)::bigint $$;

-- Новая заявка. Лимиты проверяются под блокировкой игрока, чтобы параллельные запросы их не обошли.
create or replace function eco_submit(p_user bigint, p_description text, p_media jsonb)
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_id bigint;
begin
  perform 1 from users u where u.id = p_user for update;
  if not found then raise exception 'user_not_found'; end if;
  if char_length(coalesce(trim(p_description), '')) < 3 or char_length(p_description) > 500 then
    raise exception 'bad_description';
  end if;
  if jsonb_typeof(p_media) <> 'array' or jsonb_array_length(p_media) < 1 or jsonb_array_length(p_media) > 5 then
    raise exception 'bad_media';
  end if;
  if (select count(*) from eco_reports r where r.user_id = p_user and r.status = 'pending') >= 3 then
    raise exception 'eco_pending_limit';
  end if;
  if (select count(*) from eco_reports r where r.user_id = p_user and r.created_at > now() - interval '1 day')
     >= greatest(setting_num('eco_daily_limit', 5), 1) then
    raise exception 'eco_daily_limit';
  end if;

  insert into eco_reports (user_id, description, media) values (p_user, trim(p_description), p_media)
  returning id into v_id;
  return v_id;
end;
$$;

-- Решение по заявке. Повторно проверить уже проверенную нельзя (вернёт changed = false).
create or replace function eco_review(
  p_report bigint, p_approve boolean, p_reward bigint, p_comment text, p_reviewer_tg bigint, p_reviewer_name text
)
returns table (changed boolean, user_id bigint, reward bigint)
language plpgsql security definer set search_path = public as $$
declare
  v_rep     eco_reports%rowtype;
  v_reward  bigint := case when p_approve then coalesce(p_reward, eco_reward()) else 0 end;
  v_balance bigint;
begin
  if v_reward < 0 or v_reward > 1000000000000 then raise exception 'bad_amount'; end if;
  select * into v_rep from eco_reports r where r.id = p_report for update;
  if not found then raise exception 'report_not_found'; end if;
  if v_rep.status <> 'pending' then
    changed := false; user_id := v_rep.user_id; reward := v_rep.reward;
    return next;
    return;
  end if;

  update eco_reports r
  set status = case when p_approve then 'approved' else 'rejected' end,
      reward = v_reward,
      reviewer_tg = p_reviewer_tg,
      reviewer_name = p_reviewer_name,
      review_comment = nullif(trim(coalesce(p_comment, '')), ''),
      reviewed_at = clock_timestamp()
  where r.id = p_report;

  if v_reward > 0 then
    update users u set balance = u.balance + v_reward where u.id = v_rep.user_id returning u.balance into v_balance;
    insert into ledger (user_id, amount, balance_after, reason) values (v_rep.user_id, v_reward, v_balance, 'eco');
  end if;
  insert into notices (user_id, kind, amount, title, body)
  values (
    v_rep.user_id,
    case when p_approve then 'eco_approved' else 'eco_rejected' end,
    v_reward,
    left(v_rep.description, 60),
    coalesce(nullif(trim(coalesce(p_comment, '')), ''), p_reviewer_name)
  );

  changed := true; user_id := v_rep.user_id; reward := v_reward;
  return next;
end;
$$;

revoke all on function eco_reward() from public, anon, authenticated;
revoke all on function eco_submit(bigint, text, jsonb), eco_review(bigint, boolean, bigint, text, bigint, text)
  from public, anon, authenticated;
grant execute on function eco_submit(bigint, text, jsonb), eco_review(bigint, boolean, bigint, text, bigint, text)
  to service_role;

-- Ставки выключены, поэтому фрибеты на колесе бесполезны: выключаем такие призы.
-- Если ставки вернут, включить их обратно в админке (Колесо -> приз -> «вкл»).
update prizes set active = false where kind = 'free_bet' and active;

-- Закрытый бакет для фото и видео (до 30 МБ на файл). В тестовой базе без Storage этот шаг пропускается.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('eco-reports', 'eco-reports', false, 31457280,
            array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm'])
    on conflict (id) do nothing;
  end if;
end $$;

notify pgrst, 'reload schema';
