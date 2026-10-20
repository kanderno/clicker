import WebApp from '@twa-dev/sdk';

// В разработке — прокси Vite (/api -> localhost:3001).
// В продакшене фронт и API на одном домене, поэтому запросы идут в корень.
// VITE_API_BASE нужен, только если фронт вынесен на отдельный домен (например, Vercel).
const BASE = import.meta.env.VITE_API_BASE ?? (import.meta.env.DEV ? '/api' : '');

let token = null; // храним только в памяти; при каждом запуске заново авторизуемся

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      // Content-Type только если есть тело: Fastify отклоняет DELETE с JSON-заголовком и пустым телом
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `http_${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function login() {
  const initData = WebApp.initData;
  if (!initData) {
    const err = new Error('not_in_telegram');
    throw err;
  }
  const data = await request('/auth', { method: 'POST', body: JSON.stringify({ initData }) });
  token = data.token;
  return { ...data.user, isAdmin: Boolean(data.isAdmin) };
}

export const getMe = () => request('/me').then((d) => d.user);

// Отправка накопленных тапов. keepalive: запрос доживёт, даже если приложение закрывают.
export const sendTaps = (count) =>
  request('/tap', { method: 'POST', body: JSON.stringify({ count }), keepalive: true });

// ---------- Банк ----------
export const getBankState = () => request('/bank/state');
export const bankDeposit = (amount) => request('/bank/deposit', { method: 'POST', body: JSON.stringify({ amount }) });
export const bankWithdraw = (amount) => request('/bank/withdraw', { method: 'POST', body: JSON.stringify({ amount }) });

// ---------- Админка ----------
export const adminListEvents = () => request('/admin/events');
export const adminCreateEvent = (payload) =>
  request('/admin/events', { method: 'POST', body: JSON.stringify(payload) });
export const adminDeleteEvent = (id) => request(`/admin/events/${id}`, { method: 'DELETE' });

// ---------- Предсказания ----------
export const getEvents = () => request('/events');
export const placeBet = (eventId, optionId, amount) =>
  request('/bet', { method: 'POST', body: JSON.stringify({ eventId, optionId, amount }) });

// ---------- Закрытие событий и история ставок ----------
export const getMyBets = () => request('/bets/mine');
export const adminResolveEvent = (id, optionId) =>
  request(`/admin/events/${id}/resolve`, { method: 'POST', body: JSON.stringify({ optionId }) });
export const adminCancelEvent = (id) => request(`/admin/events/${id}/cancel`, { method: 'POST' });

// ---------- Колесо фортуны ----------
export const getWheel = () => request('/wheel');
export const spinWheel = (mode) => request('/wheel/spin', { method: 'POST', body: JSON.stringify({ mode }) });

// ---------- Бесплатные ставки ----------
export const getFreeBets = () => request('/free-bets');
export const placeFreeBet = (eventId, optionId, freeBetId) =>
  request('/bet/free', { method: 'POST', body: JSON.stringify({ eventId, optionId, freeBetId }) });

// ---------- Уведомления о кражах ----------
export const getUnseenSteals = () => request('/steals/unseen');
export const markStealsSeen = (upToId) =>
  request('/steals/seen', { method: 'POST', body: JSON.stringify({ upToId }) });

// ---------- Майнеры ----------
export const getMiners = () => request('/miners');
export const buildMiner = (typeId) => request('/miners/build', { method: 'POST', body: JSON.stringify({ typeId }) });
export const upgradeMiner = (id) => request(`/miners/${id}/upgrade`, { method: 'POST' });
export const collectMiners = () => request('/miners/collect', { method: 'POST' });
export const buyPart = (partId, qty = 1) =>
  request('/parts/buy', { method: 'POST', body: JSON.stringify({ partId, qty }) });
