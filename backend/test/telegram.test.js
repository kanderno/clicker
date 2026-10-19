import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { validateInitData } from '../src/telegram.js';

const BOT = '123456:TEST_TOKEN';

function sign(fields, botToken = BOT) {
  const dcs = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

const now = () => Math.floor(Date.now() / 1000);
const userJson = JSON.stringify({ id: 42, first_name: 'Тест', username: 'tester' });

test('валидная подпись проходит', () => {
  const r = validateInitData(sign({ auth_date: String(now()), user: userJson, query_id: 'AAA' }), BOT);
  assert.equal(r.user.id, 42);
});

test('чужой токен бота отклоняется', () => {
  const init = sign({ auth_date: String(now()), user: userJson }, 'other:TOKEN');
  assert.equal(validateInitData(init, BOT), null);
});

test('подмена user ломает подпись', () => {
  const init = sign({ auth_date: String(now()), user: userJson });
  const p = new URLSearchParams(init);
  p.set('user', JSON.stringify({ id: 1, first_name: 'Admin' }));
  assert.equal(validateInitData(p.toString(), BOT), null);
});

test('устаревшие данные отклоняются', () => {
  const init = sign({ auth_date: String(now() - 3 * 24 * 3600), user: userJson });
  assert.equal(validateInitData(init, BOT), null);
});

test('мусор и пустые значения отклоняются', () => {
  assert.equal(validateInitData('', BOT), null);
  assert.equal(validateInitData('hash=abc', BOT), null);
  assert.equal(validateInitData(undefined, BOT), null);
  assert.equal(validateInitData('auth_date=1&hash=zz', BOT), null);
});
