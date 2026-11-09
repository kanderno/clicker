-- Этап 12: админка контента — призы колеса, цены, картинки. Выполнить целиком в Supabase -> SQL Editor.
--
--  * images — картинки, загруженные админом (логотип, монета, локации, призы колеса).
--    Хранятся в базе в base64 (до ~700 КБ), сервер отдаёт их по адресу /img/<id>.
--  * prizes.image_url — своя картинка для сектора колеса.
--  * Логотип и монета задаются в settings: ключи logo_url и coin_url.

create table if not exists images (
  id         bigint generated always as identity primary key,
  mime       text   not null check (mime in ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  data       text   not null,                                -- base64
  created_at timestamptz not null default now()
);
alter table images enable row level security;

alter table prizes add column if not exists image_url text;

notify pgrst, 'reload schema';
