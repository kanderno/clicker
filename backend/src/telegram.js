import crypto from 'node:crypto';

/**
 * Проверка подписи initData по документации Telegram (HMAC-SHA256).
 * Возвращает { user, authDate } или null, если подпись неверна / данные устарели.
 */
export function validateInitData(initData, botToken, maxAgeSec = 24 * 60 * 60) {
  if (typeof initData !== 'string' || !initData) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculated = crypto.createHmac('sha256', secret).update(dataCheckString).digest();
  const received = Buffer.from(hash, 'hex');

  if (received.length !== calculated.length || !crypto.timingSafeEqual(received, calculated)) {
    return null;
  }

  const authDate = Number(params.get('auth_date'));
  const now = Date.now() / 1000;
  if (!authDate || now - authDate > maxAgeSec || authDate - now > 300) return null;

  let user;
  try {
    user = JSON.parse(params.get('user'));
  } catch {
    return null;
  }
  if (!user || typeof user.id !== 'number') return null;

  return { user, authDate };
}
