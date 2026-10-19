// Настройка бота: npm run bot:setup -- https://адрес-фронтенда [--webhook]
//  * без --webhook: команды, описание, кнопка меню (для разработки, приветствия принимает bot:poll)
//  * с --webhook: ещё и вебхук на {PUBLIC_API_URL или адрес фронтенда + /api}/telegram/webhook (для продакшена)
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createTelegramApi, isHttpsUrl } from '../src/bot.js';
import { setupBot, upsertEnvLine } from '../src/botSetup.js';

const args = process.argv.slice(2);
const withWebhook = args.includes('--webhook');
const urlArg = args.find((a) => !a.startsWith('--'));

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Нет BOT_TOKEN в backend/.env');
  process.exit(1);
}
const webAppUrl = (urlArg || process.env.WEBAPP_URL || '').replace(/\/+$/, '');
if (!webAppUrl) {
  console.error('Укажи адрес фронтенда: npm run bot:setup -- https://адрес-фронтенда');
  process.exit(1);
}

if (!isHttpsUrl(webAppUrl)) {
  console.error('Не получилось: адрес должен быть https-ссылкой (Telegram не открывает http)');
  process.exit(1); // ничего не записано и ничего не отправлено
}

const envPath = fileURLToPath(new URL('../.env', import.meta.url));
let envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

let webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET || null;
const generatedSecret = withWebhook && !webhookSecret;
if (generatedSecret) webhookSecret = crypto.randomBytes(24).toString('hex');

try {
  const api = createTelegramApi(token, { base: process.env.TELEGRAM_API_BASE || 'https://api.telegram.org' });
  const apiBaseUrl = withWebhook ? process.env.PUBLIC_API_URL || `${webAppUrl}/api` : null;
  const done = await setupBot(api, { webAppUrl, apiBaseUrl, webhookSecret });

  // В .env пишем только после успешной настройки: при ошибке файл остаётся как был
  envText = upsertEnvLine(envText, 'WEBAPP_URL', webAppUrl);
  if (generatedSecret) envText = upsertEnvLine(envText, 'TELEGRAM_WEBHOOK_SECRET', webhookSecret);
  fs.writeFileSync(envPath, envText);

  console.log('Готово:');
  for (const d of done) console.log('  ✓', d);
  console.log(`\nАдрес игры в боте: ${webAppUrl}`);
  console.log('WEBAPP_URL сохранён в backend/.env. Перезапусти бэкенд (Ctrl+C, npm run dev:back), если он запущен.');
  if (generatedSecret) console.log('Создан TELEGRAM_WEBHOOK_SECRET (в backend/.env). Добавь его и WEBAPP_URL в переменные хостинга бэкенда.');
  if (!withWebhook) console.log('Чтобы бот отвечал на /start, запусти в отдельном окне: npm run bot:poll');
} catch (err) {
  console.error('Не получилось:', err.message);
  process.exit(1);
}
