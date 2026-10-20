# Telegram Mini App: кликер + экономика

Монорепо: `/frontend` (React + Vite + Tailwind + @twa-dev/sdk), `/backend` (Node.js + Fastify).

**Продакшен на Bothost:** см. [DEPLOY.md](DEPLOY.md). Один контейнер: Fastify раздаёт Mini App, API и вебхук, база — в Supabase.

## Запуск
```bash
npm run install:all
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
npm run dev:back    # http://localhost:3001/health
npm run dev:front   # http://localhost:5173
```

## Этапы
- [x] 0. Подготовка (каркас)
- [x] 1. Авторизация через Telegram (код готов, проверка в Telegram)
- [x] 2. Кликер (нужно выполнить backend/sql/002_clicker.sql в Supabase)
- [x] 3. Банк (нужно выполнить backend/sql/003_bank.sql в Supabase)
- [x] 4. Предсказания: 4a админка, 4b ставки, 4c выплаты (нужны backend/sql/004, 005, 006)
- [x] 5. Колесо: 5a монеты+докупка (backend/sql/007), 5b free bets (backend/sql/008), 5c воровство (backend/sql/009, готово)
- [x] 6. Майнеры (нужен backend/sql/010_miners.sql)

Правила разработки: см. `CLAUDE.md`.

## Этап 1: как проверить в Telegram
1. `npm run dev:back` и `npm run dev:front` (два окна).
2. `cloudflared tunnel --url http://localhost:5173` — получишь https-ссылку.
3. @BotFather → /mybots → твой бот → Bot Settings → Menu Button → Configure → вставь ссылку.
4. Открой бота в Telegram → кнопка меню → видишь своё имя и баланс 0.
Тесты подписи: `npm --prefix backend test`.

## Приветствие в Telegram-боте
Бот отвечает на `/start`, `/help`, `/play` и показывает кнопку «Играть», которая открывает мини-приложение.

Разработка (адрес фронтенда = ссылка туннеля):
1. `npm run bot:setup -- https://ссылка-туннеля.trycloudflare.com`: команды, описание, кнопка меню (BotFather для ссылки больше не нужен), адрес пишется в `backend/.env`.
2. Перезапустить бэкенд (`npm run dev:back`).
3. В отдельном окне `npm run bot:poll`: бот слушает сообщения.
При каждой новой ссылке туннеля повторять шаги 1–3.

Продакшен (вебхук, без постоянно запущенного окна):
`npm run bot:setup -- https://адрес-фронтенда --webhook` (если бэкенд на отдельном адресе, задай `PUBLIC_API_URL`).
В переменные хостинга бэкенда добавить `WEBAPP_URL` и `TELEGRAM_WEBHOOK_SECRET` (их создаёт скрипт в `backend/.env`).
