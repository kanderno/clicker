// Одноразовая настройка бота на продакшен-домене.
// Запуск: npm --prefix backend run bot:prod
// Нужны BOT_TOKEN, WEBAPP_URL, TELEGRAM_WEBHOOK_SECRET (и PUBLIC_API_URL, если API на другом домене).
import { createTelegramApi, explainNetworkError, isHttpsUrl } from '../src/bot.js';
import { setupBot } from '../src/botSetup.js';

const token = process.env.BOT_TOKEN;
const webAppUrl = (process.env.WEBAPP_URL || '').replace(/\/+$/, '');
const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET || '';
const apiBaseUrl = (process.env.PUBLIC_API_URL || webAppUrl).replace(/\/+$/, '');

if (!token || !isHttpsUrl(webAppUrl) || !webhookSecret) {
  console.error('Заполни BOT_TOKEN, WEBAPP_URL (https) и TELEGRAM_WEBHOOK_SECRET в backend/.env');
  process.exit(1);
}

try {
  const api = createTelegramApi(token, {
    base: process.env.TELEGRAM_API_BASE || 'https://api.telegram.org',
  });
  const done = await setupBot(api, { webAppUrl, apiBaseUrl, webhookSecret });
  console.log('Готово:');
  for (const d of done) console.log('  ✓', d);
  console.log(`\nMini App: ${webAppUrl}`);
  console.log(`Webhook: ${apiBaseUrl}/telegram/webhook`);
  console.log('\nПроверка: открой бота в Telegram и нажми /start.');
} catch (err) {
  console.error('Не получилось:', explainNetworkError(err));
  console.error('Проверь, что BOT_TOKEN верный, а домен уже открывается по HTTPS.');
  process.exit(1);
}
