const required = ['BOT_TOKEN', 'JWT_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Не заполнены переменные в backend/.env: ${missing.join(', ')}`);
  process.exit(1);
}
if (process.env.JWT_SECRET.length < 32) {
  console.error('JWT_SECRET слишком короткий (нужно минимум 32 символа).');
  process.exit(1);
}

export const config = {
  port: Number(process.env.PORT) || 3001,
  origins: (process.env.FRONTEND_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean),
  botToken: process.env.BOT_TOKEN,
  // Приветствие бота (необязательно): адрес игры и секрет вебхука. Без них маршрут вебхука выключен.
  webAppUrl: (process.env.WEBAPP_URL || '').replace(/\/+$/, ''),
  webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
  telegramApiBase: process.env.TELEGRAM_API_BASE || 'https://api.telegram.org',
  // Telegram ID админов через запятую. Пусто = админов нет.
  adminIds: (process.env.ADMIN_TELEGRAM_IDS || '')
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isSafeInteger(n) && n > 0),
  // Проверяющие заявок «Экология» (кроме админов): Telegram ID через запятую. Видят только проверку заявок.
  ecoModeratorIds: (process.env.ECO_MODERATOR_TELEGRAM_IDS || '')
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isSafeInteger(n) && n > 0),
  // Чьё имя стоит под проверкой заявок (игроки видят «Проверяет: …»).
  ecoReviewerName: (process.env.ECO_REVIEWER_NAME || 'Ilyas Upushev').trim().slice(0, 60),
  // Ставки и переводы включены (выключить: FEATURE_BETS=0 / FEATURE_TRANSFERS=0), «Экология» выключена
  // (вернуть: FEATURE_ECO=1). Флаги должны совпадать с frontend/src/features.js.
  features: {
    bets: process.env.FEATURE_BETS !== '0',
    transfers: process.env.FEATURE_TRANSFERS !== '0',
    eco: process.env.FEATURE_ECO === '1',
  },
  jwtSecret: process.env.JWT_SECRET,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_SERVICE_KEY,
};
