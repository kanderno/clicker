-- Этап 4a: предсказания (данные + создание событий админом). Выполнить в Supabase -> SQL Editor.

create table if not exists events (
  id                bigint generated always as identity primary key,
  title             text not null check (char_length(title) between 3 and 200),
  description       text check (description is null or char_length(description) <= 1000),
  deadline          timestamptz not null,
  status            text not null default 'open' check (status in ('open', 'resolved', 'cancelled')),
  winning_option_id bigint,
  created_at        timestamptz not null default now(),
  resolved_at       timestamptz
);

create table if not exists event_options (
  id       bigint generated always as identity primary key,
  event_id bigint not null references events(id) on delete cascade,
  title    text not null check (char_length(title) between 1 and 100),
  pool     bigint not null default 0 check (pool >= 0),   -- сумма ставок на этот вариант
  position int not null default 0
);
create index if not exists event_options_event_idx on event_options (event_id);

alter table events
  drop constraint if exists events_winning_option_fk,
  add constraint events_winning_option_fk foreign key (winning_option_id) references event_options(id);

-- Ставки (заполняются на этапе 4b). Удалить событие со ставками нельзя (FK без cascade).
create table if not exists bets (
  id         bigint generated always as identity primary key,
  user_id    bigint not null references users(id),
  event_id   bigint not null references events(id),
  option_id  bigint not null references event_options(id),
  amount     bigint not null check (amount > 0),
  payout     bigint,                                      -- заполняется при закрытии события
  created_at timestamptz not null default now()
);
create index if not exists bets_event_idx on bets (event_id);
create index if not exists bets_user_idx  on bets (user_id, created_at desc);

alter table events        enable row level security;
alter table event_options enable row level security;
alter table bets          enable row level security;

-- Создание события вместе с вариантами одной транзакцией.
create or replace function admin_create_event(
  p_title text, p_description text, p_deadline timestamptz, p_options text[]
) returns bigint
language plpgsql security definer set search_path = public
as $$
declare
  v_title text := btrim(coalesce(p_title, ''));
  v_desc  text := nullif(btrim(coalesce(p_description, '')), '');
  v_opt   text;
  v_clean text[] := '{}';
  v_id    bigint;
  v_pos   int := 0;
begin
  if char_length(v_title) < 3 or char_length(v_title) > 200 then raise exception 'bad_title'; end if;
  if v_desc is not null and char_length(v_desc) > 1000 then raise exception 'bad_title'; end if;
  if p_deadline is null or p_deadline <= now() then raise exception 'bad_deadline'; end if;

  foreach v_opt in array coalesce(p_options, '{}'::text[]) loop
    v_opt := btrim(coalesce(v_opt, ''));
    if char_length(v_opt) < 1 or char_length(v_opt) > 100 then raise exception 'bad_options'; end if;
    v_clean := v_clean || v_opt;
  end loop;

  if coalesce(array_length(v_clean, 1), 0) < 2 or array_length(v_clean, 1) > 10 then
    raise exception 'bad_options';
  end if;
  if (select count(distinct lower(x)) from unnest(v_clean) as x) <> array_length(v_clean, 1) then
    raise exception 'bad_options';  -- повторяющиеся варианты
  end if;

  insert into events (title, description, deadline) values (v_title, v_desc, p_deadline)
  returning id into v_id;

  foreach v_opt in array v_clean loop
    v_pos := v_pos + 1;
    insert into event_options (event_id, title, position) values (v_id, v_opt, v_pos);
  end loop;

  return v_id;
end;
$$;

revoke all on function admin_create_event(text, text, timestamptz, text[]) from public, anon, authenticated;
grant execute on function admin_create_event(text, text, timestamptz, text[]) to service_role;

notify pgrst, 'reload schema';
