// Диагностика: npm run bot:check
// Проверяет связь с Telegram, токен (какой именно бот), вебхук и адрес игры.
import { createTelegramApi, explainNetworkError, isHttpsUrl } from '../src/bot.js';

const base = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
const token = process.env.BOT_TOKEN;
const ok = (m) => console.log('  ✓', m);
const bad = (m) => console.log('  ✗', m);
let problems = 0;

console.log('1. Связь с серверами Telegram');
try {
  const res = await fetch(base, { signal: AbortSignal.timeout(15000) });
  ok(`api.telegram.org отвечает (HTTP ${res.status})`);
} catch (err) {
  problems++;
  bad(explainNetworkError(err));
}

console.log('2. Токен бота');
if (!token) {
  problems++;
  bad('В backend/.env нет BOT_TOKEN');
} else {
  const api = createTelegramApi(token, { base });
  try {
    const me = await api.call('getMe');
    ok(`токен верный: бот @${me.username} (${me.first_name}). Пиши именно этому боту.`);
    const hook = await api.call('getWebhookInfo');
    if (hook.url) bad(`включён вебхук (${hook.url}): bot:poll его отключит при запуске`);
    else ok('вебхук не включён (bot:poll может слушать сообщения)');
    if (hook.last_error_message) bad(`последняя ошибка вебхука: ${hook.last_error_message}`);
  } catch (err) {
    problems++;
    bad(/Unauthorized/i.test(err.message) ? 'токен неверный или перевыпущен: возьми актуальный в @BotFather (API Token)' : explainNetworkError(err));
  }
}

console.log('3. Адрес игры');
const url = (process.env.WEBAPP_URL || '').replace(/\/+$/, '');
if (isHttpsUrl(url)) ok(`WEBAPP_URL = ${url}`);
else {
  problems++;
  bad('WEBAPP_URL не задан: выполни npm run bot:setup -- https://ссылка-туннеля');
}

console.log(problems ? `\nНайдено проблем: ${problems}` : '\nВсё в порядке, можно запускать npm run bot:poll');
process.exit(problems ? 1 : 0);
