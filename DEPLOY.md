# Деплой на Bothost

Один контейнер: Fastify отдаёт Mini App, API и принимает вебхук Telegram. База остаётся в Supabase, поэтому локальный диск и миграции на хостинге не нужны.

```
Telegram → https://домен/telegram/webhook ─┐
Telegram → https://домен/ (Mini App)       ├→ Node/Fastify на Bothost → Supabase
Mini App → https://домен/auth, /tap, ...   ┘
```

## Что уже подготовлено

- `index.js` и `package.json` в корне — точка входа и зависимости для автосборки Bothost.
- `Dockerfile` — запасной вариант: собирает React и запускает бэкенд в одном образе.
- `frontend/dist` — уже собранный Mini App, его не нужно собирать на хостинге.
- `backend/src/index.js` — раздаёт `frontend/dist` и `/assets/*`.
- `ws` — замена WebSocket для Node.js 20: свежий supabase-js без неё не стартует.
- `frontend/src/api.js` — в продакшене обращается к API на том же домене.
- `backend/scripts/setup-production.js` — ставит команды, описание, кнопку меню и вебхук.
- `.dockerignore` — не тащит в образ `node_modules`, `.env`, `dist` и архив.

## 1. Тариф и бот

1. Зарегистрируйся на [bothost.ru](https://bothost.ru/) и выбери **Базовый (99 ₽/мес)**. На бесплатном нет домена, вебхука и переменных окружения.
2. Создай бота: платформа **Telegram**, язык **Node.js**.
3. **Не включай** «Использовать Dockerfile из репозитория» — используется обычная автосборка Node.js.
4. Главный файл: `index.js`. Внутренний порт: `3000`.
5. Включи **«Веб-интерфейс / домен»** и запомни HTTPS-адрес.

## 2. Код на Bothost

**Вариант А — GitHub (рекомендую).** Залей проект в приватный репозиторий и подключи его в Bothost. При каждом пуше бот пересобирается сам.

**Вариант Б — архив.** В профиле Bothost включи «Загрузка бота из архива» и загрузи готовый `tg-clicker-bothost.zip` через «Загрузить из архива». В нём уже есть `frontend/dist`, `index.js` и корневой `package.json`. Лимит — 100 МБ.

## 3. Переменные окружения

Добавь в панели Bothost:

| Переменная | Значение |
|---|---|
| `BOT_TOKEN` | токен из @BotFather |
| `JWT_SECRET` | случайная строка от 32 символов |
| `SUPABASE_URL` | `https://....supabase.co` |
| `SUPABASE_SERVICE_KEY` | service/secret key Supabase |
| `ADMIN_TELEGRAM_IDS` | твой Telegram ID |
| `WEBAPP_URL` | `https://твой-домен` без слэша на конце |
| `TELEGRAM_WEBHOOK_SECRET` | случайная строка, например 48 hex-символов |
| `FRONTEND_ORIGIN` | `https://твой-домен` (можно не задавать) |
| `PUBLIC_API_URL` | не нужен, если API на том же домене |

`PORT` не задавай — Bothost передаёт его сам. `BOT_TOKEN`, `JWT_SECRET`, `SUPABASE_SERVICE_KEY` и `TELEGRAM_WEBHOOK_SECRET` не должны попадать в Git и в папку `frontend/`.

Секрет можно сгенерировать так:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

## 4. Один раз настроить Telegram

После первого успешного деплоя выполни **на своём компьютере** из папки проекта:

```bash
BOT_TOKEN="токен" \
WEBAPP_URL="https://твой-домен" \
TELEGRAM_WEBHOOK_SECRET="тот-же-секрет-что-в-Bothost" \
node backend/scripts/setup-production.js
```

Скрипт поставит команды `/start`, `/play`, `/help`, описание, кнопку меню «Играть» и вебхук на `https://твой-домен/telegram/webhook`. Повторный запуск безопасен.

## 5. Проверка

1. `https://твой-домен/health` → `{"ok":true,...}`.
2. `https://твой-домен/` → открывается экран с монетой.
3. В Telegram: `/start` → приходит приветствие с кнопкой «Играть».
4. Нажми монету, закрой и открой Mini App — баланс сохранился.
5. Перезапусти контейнер в Bothost — баланс всё равно на месте (он в Supabase).

## Если что-то не работает

- **502 / пустая страница.** В логах проверь, что приложение слушает `0.0.0.0` и `PORT`. Порт в панели должен совпадать с `3000`.
- **`Mini App не собрана`.** Нет папки `frontend/dist`. Собери её локально командой `npm run build` и залей в Git/архив.
- **`Cannot find package 'fastify'`.** Bothost запускает код из `/app`, а зависимости не поставились. Главный файл должен быть `index.js`, а в корневом `package.json` — блок `dependencies` (он уже есть). После правок сделай новый деплой, не просто рестарт.
- **`Node.js detected but native WebSocket not found`.** В проекте уже есть `ws` и подключение в `backend/src/db.js`. Если ошибка осталась — залей новый архив и пересобери: старый `node_modules` мог остаться от предыдущей сборки.
- **404 на вебхуке.** URL должен быть `https://домен/telegram/webhook` (без `/api`). Секрет в Telegram и в Bothost должен совпадать.
- **`invalid_init_data`.** Mini App открыт не из Telegram или `BOT_TOKEN` не тот, которым подписаны данные.
- **CORS.** Если фронт на другом домене (Vercel), задай `FRONTEND_ORIGIN=https://фронт` и `VITE_API_BASE=https://бэкенд` при сборке.

## Необязательно: фронт на Vercel

Схема работает, но добавляет второй домен и CORS:

1. На Bothost оставь только API и бота, включи домен.
2. На Vercel задеплой `frontend/`, в настройках проекта задай `VITE_API_BASE=https://твой-домен`.
3. В Bothost задай `FRONTEND_ORIGIN=https://проект.vercel.app`.
4. Вебхук и кнопку меню оставь на домене Bothost.

Для этого проекта выигрыша нет: фронт лёгкий, а вся логика уже на сервере.

## Безопасность

В исходном архиве был файл `backend/.env` с реальными ключами. Он исключён из деплой-архива. Если этот архив кому-то передавался, перевыпусти `BOT_TOKEN` в @BotFather и service key в Supabase.
