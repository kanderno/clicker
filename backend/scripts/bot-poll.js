// Бот для разработки: npm run bot:poll (не нужен публичный адрес бэкенда).
// В продакшене вместо этого работает вебхук (npm run bot:setup -- <адрес> --webhook).
import { createTelegramApi, handleUpdate, isHttpsUrl } from '../src/bot.js';

const token = process.env.BOT_TOKEN;
const webAppUrl = (process.env.WEBAPP_URL || '').replace(/\/+$/, '');
if (!token) {
  console.error('Нет BOT_TOKEN в backend/.env');
  process.exit(1);
}
if (!isHttpsUrl(webAppUrl)) {
  console.error('Нет WEBAPP_URL (https). Сначала: npm run bot:setup -- https://адрес-фронтенда');
  process.exit(1);
}

const api = createTelegramApi(token, { base: process.env.TELEGRAM_API_BASE || 'https://api.telegram.org' });
await api.call('deleteWebhook', { drop_pending_updates: false }); // getUpdates не работает при включённом вебхуке
console.log('Бот слушает сообщения. Остановить: Ctrl+C');

let offset = 0;
for (;;) {
  try {
    const updates = await api.call('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
    for (const u of updates) {
      offset = u.update_id + 1;
      try {
        await handleUpdate(u, { api, webAppUrl });
      } catch (err) {
        console.error('Ошибка ответа:', err.message);
      }
    }
  } catch (err) {
    console.error('Нет связи с Telegram, повтор через 5 сек:', err.message);
    await new Promise((r) => setTimeout(r, 5000));
  }
}
