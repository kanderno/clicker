import crypto from 'node:crypto';

// ---------- тексты ----------
export const COMMANDS = [
  { command: 'start', description: 'Начать игру' },
  { command: 'play', description: 'Открыть игру' },
  { command: 'help', description: 'Как играть' },
];

// Показывается в пустом чате с ботом, до нажатия «Старт» (лимит Telegram: 512 символов)
export const BOT_DESCRIPTION =
  'Кликер с экономикой: тапай монеты, делай прогнозы на абсурдные события, крути колесо фортуны, ' +
  'строй майнеры с пассивным доходом и копи монеты в банке под проценты. Нажми «Старт» и поехали!';

// Показывается в профиле бота (лимит Telegram: 120 символов)
export const BOT_SHORT_DESCRIPTION = 'Кликер, прогнозы, колесо фортуны, майнеры и банк. Играй прямо в Telegram!';

export const escapeHtml = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function welcomeText(firstName) {
  const name = escapeHtml(firstName || 'игрок');
  return (
    `Привет, <b>${name}</b>! 👋\n\n` +
    'Добро пожаловать в игру. Здесь можно:\n' +
    '• 👆 тапать и зарабатывать монеты\n' +
    '• 🎯 делать прогнозы на абсурдные события\n' +
    '• 🎡 крутить колесо фортуны (и красть монеты у других)\n' +
    '• ⛏ строить майнеры с пассивным доходом\n' +
    '• 🏦 копить монеты в банке под проценты\n\n' +
    'Жми кнопку ниже и заходи в кликер 👇'
  );
}

export const HELP_TEXT =
  '<b>Как играть</b>\n\n' +
  '• <b>Кликер:</b> тапай по монете, монеты копятся на твоём балансе.\n' +
  '• <b>Прогнозы:</b> ставь монеты на исход событий, победители делят общий банк.\n' +
  '• <b>Колесо:</b> один бесплатный спин в день, можно докупить. Призы: монеты, бесплатные ставки, детали и даже кража монет.\n' +
  '• <b>Майнеры:</b> собирай их из деталей, доход копится до 2 часов, заходи собирать.\n' +
  '• <b>Банк:</b> монеты на счёте растут с процентами и защищены от кражи.\n\n' +
  'Нажми кнопку, чтобы начать 👇';

export const playKeyboard = (webAppUrl, text = 'Играть') => ({
  inline_keyboard: [[{ text, web_app: { url: webAppUrl } }]],
});

// ---------- обработка сообщения ----------
/**
 * Отвечает на личные сообщения: /start, /help, /play и любой другой текст (всегда с кнопкой «Играть»).
 * Возвращает true, если ответ отправлен. Групповые чаты и не-текстовые события игнорируются.
 */
export async function handleUpdate(update, { api, webAppUrl }) {
  const msg = update?.message;
  if (!msg || msg.chat?.type !== 'private' || typeof msg.text !== 'string') return false;

  // "/start@my_bot ref_5" -> "/start"
  const command = msg.text.trim().split(/\s+/)[0].split('@')[0].toLowerCase();

  let text;
  if (command === '/start') text = welcomeText(msg.from?.first_name);
  else if (command === '/help') text = HELP_TEXT;
  else if (command === '/play') text = 'Жми кнопку, чтобы открыть игру 👇';
  else text = 'Я умею только открывать игру. Жми кнопку 👇';

  await api.sendMessage(msg.chat.id, text, { reply_markup: playKeyboard(webAppUrl) });
  return true;
}

// ---------- безопасность вебхука ----------
/** Сравнение секрета вебхука за постоянное время (чужие запросы без секрета отклоняются). */
export function secretMatches(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = crypto.createHash('sha256').update(received).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export const isHttpsUrl = (u) => {
  try {
    return new URL(u).protocol === 'https:';
  } catch {
    return false;
  }
};

// ---------- клиент Bot API ----------
export function createTelegramApi(token, { base = 'https://api.telegram.org', fetchImpl = fetch } = {}) {
  const call = async (method, payload = {}) => {
    const res = await fetchImpl(`${base}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    // В сообщении об ошибке нет адреса запроса: в нём был бы токен бота
    if (!data.ok) throw new Error(`telegram ${method}: ${data.description || `http ${res.status}`}`);
    return data.result;
  };
  return {
    call,
    sendMessage: (chat_id, text, extra = {}) =>
      call('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }),
  };
}

// ---------- понятное объяснение сетевых ошибок ----------
const DNS_CODES = ['ENOTFOUND', 'EAI_AGAIN'];
const BLOCK_CODES = ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET'];

/** "fetch failed" ничего не говорит: достаём настоящую причину (err.cause) и подсказываем, что делать. */
export function explainNetworkError(err) {
  const inner = err?.cause?.errors?.[0] ?? err?.cause ?? err;
  const code = inner?.code || err?.cause?.code || err?.code || '';
  const detail = inner?.message || err?.cause?.message || err?.message || String(err);
  let hint = 'Проверь интернет и попробуй ещё раз.';
  if (DNS_CODES.includes(code)) {
    hint = 'Не находится адрес api.telegram.org (проблема DNS). Проверь интернет или включи VPN.';
  } else if (BLOCK_CODES.includes(code)) {
    hint = 'Нет соединения с api.telegram.org: его может блокировать провайдер. Включи VPN для всего компьютера (не только для браузера или Telegram) и повтори.';
  } else if (/CERT|SSL|TLS/i.test(code) || /certificate/i.test(detail)) {
    hint = 'Ошибка сертификата: мешает антивирус или прокси, проверяющий HTTPS. Отключи проверку HTTPS в антивирусе или включи VPN.';
  }
  return `${detail}${code && !detail.includes(code) ? ` (${code})` : ''}. ${hint}`;
}
