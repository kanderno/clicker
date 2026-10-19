// Сквозная проверка: настоящий бэкенд + поддельный Telegram. Вебхук принимает обновление и отправляет приветствие.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SECRET = 'test-secret-123';
let fake, fakeRequests, backend, port, noHookBackend, noHookPort;

const startBackend = async (env) => {
  const p = await freePort();
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/index.js', import.meta.url))], {
    env: {
      ...process.env, PORT: String(p), BOT_TOKEN: '123:TEST', JWT_SECRET: 'x'.repeat(40),
      SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_KEY: 'k', ...env,
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${p}/health`)).ok) return { child, port: p };
    } catch { /* ещё не поднялся */ }
    await sleep(100);
  }
  child.kill();
  throw new Error('бэкенд не запустился');
};

before(async () => {
  fakeRequests = [];
  fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      fakeRequests.push({ url: req.url, body: JSON.parse(body || '{}') });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, result: {} }));
    });
  });
  await new Promise((r) => fake.listen(0, r));
  const fakeBase = `http://127.0.0.1:${fake.address().port}`;

  ({ child: backend, port } = await startBackend({
    WEBAPP_URL: 'https://game.example.com', TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_API_BASE: fakeBase,
  }));
  const second = await startBackend({}); // без вебхука
  noHookBackend = second.child; noHookPort = second.port;
});

after(() => {
  backend?.kill();
  noHookBackend?.kill();
  fake?.close();
});

const post = (p, body, headers = {}) =>
  fetch(`http://127.0.0.1:${p}/telegram/webhook`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
const update = { update_id: 1, message: { chat: { id: 555, type: 'private' }, from: { id: 9, first_name: 'Борис' }, text: '/start' } };

test('вебхук без секрета и с неверным секретом отклоняется (403), бот ничего не отправляет', async () => {
  assert.equal((await post(port, update)).status, 403);
  assert.equal((await post(port, update, { 'x-telegram-bot-api-secret-token': 'wrong' })).status, 403);
  assert.equal(fakeRequests.length, 0);
});

test('вебхук с верным секретом: /start -> бот отправил приветствие с кнопкой «Играть»', async () => {
  const res = await post(port, update, { 'x-telegram-bot-api-secret-token': SECRET });
  assert.equal(res.status, 200);
  assert.equal(fakeRequests.length, 1);
  const r = fakeRequests[0];
  assert.equal(r.url, '/bot123:TEST/sendMessage');
  assert.equal(r.body.chat_id, 555);
  assert.ok(r.body.text.includes('Борис') && r.body.text.includes('Добро пожаловать'));
  assert.equal(r.body.parse_mode, 'HTML');
  assert.deepEqual(r.body.reply_markup.inline_keyboard[0][0], { text: 'Играть', web_app: { url: 'https://game.example.com' } });
});

test('мусорные обновления не роняют сервер и отвечают 200', async () => {
  const before = fakeRequests.length;
  for (const body of [{}, { message: null }, { message: { chat: { type: 'group' }, text: '/start' } }]) {
    assert.equal((await post(port, body, { 'x-telegram-bot-api-secret-token': SECRET })).status, 200);
  }
  assert.equal(fakeRequests.length, before);
});

test('если Telegram недоступен, вебхук всё равно отвечает 200 (иначе Telegram будет повторять сообщение)', async () => {
  fake.close();
  await sleep(50);
  const res = await post(port, update, { 'x-telegram-bot-api-secret-token': SECRET });
  assert.equal(res.status, 200);
});

test('без WEBAPP_URL и секрета маршрут вебхука выключен (404), остальной API работает', async () => {
  assert.equal((await post(noHookPort, update, { 'x-telegram-bot-api-secret-token': SECRET })).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${noHookPort}/health`)).status, 200);
});
