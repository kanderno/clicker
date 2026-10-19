-- Этап 1 (уже выполнено, лежит здесь для истории)
create table if not exists users (
  id bigint generated always as identity primary key,
  telegram_id bigint unique not null,
  username text,
  first_name text,
  balance bigint not null default 0 check (balance >= 0),
  created_at timestamptz not null default now()
);
alter table users enable row level security;
