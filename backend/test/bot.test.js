import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOT_DESCRIPTION, BOT_SHORT_DESCRIPTION, COMMANDS, createTelegramApi, escapeHtml, handleUpdate,
  isHttpsUrl, secretMatches, welcomeText,
} from '../src/bot.js';
import { setupBot, upsertEnvLine } from '../src/botSetup.js';

const URL_ = 'https://game.example.com';
const fakeApi = () => {
  const sent = [];
  return { sent, sendMessage: async (chat, text, extra) => sent.push({ chat, text, extra }) };
};
const msg = (text, extra = {}) => ({
  update_id: 1,
  message: { chat: { id: 77, type: 'private' }, from: { id: 5, first_name: 'Аня' }, text, ...extra },
});

test('escapeHtml экранирует теги: имя вроде <b>x</b> не ломает сообщение', () => {
  assert.equal(escapeHtml('<b>"A&B"</b>'), '&lt;b&gt;"A&amp;B"&lt;/b&gt;');
  assert.equal(escapeHtml(null), '');
});

test('приветствие: имя в тексте, чужие теги экранированы, есть призыв нажать кнопку', () => {
  const t = welcomeText('Аня');
  assert.ok(t.includes('<b>Аня</b>') && t.includes('кнопку'));
  assert.ok(welcomeText('<script>').includes('&lt;script&gt;'));
  assert.ok(!welcomeText('<script>').includes('<script>'));
  assert.ok(welcomeText(undefined).includes('<b>игрок</b>'));
});

test('/start: приветствие и кнопка web_app с адресом игры', async () => {
  const api = fakeApi();
  assert.equal(await handleUpdate(msg('/start'), { api, webAppUrl: URL_ }), true);
  assert.equal(api.sent.length, 1);
  assert.equal(api.sent[0].chat, 77);
  assert.ok(api.sent[0].text.includes('Аня'));
  assert.deepEqual(api.sent[0].extra.reply_markup.inline_keyboard[0][0], { text: 'Играть', web_app: { url: URL_ } });
});

test('/start с параметром и с именем бота тоже считается стартом', async () => {
  for (const text of ['/start ref_5', '/start@my_game_bot', '/START', '  /start  ']) {
    const api = fakeApi();
    await handleUpdate(msg(text), { api, webAppUrl: URL_ });
    assert.ok(api.sent[0].text.includes('Добро пожаловать'), text);
  }
});

test('/help, /play и любой другой текст отвечают кнопкой «Играть»', async () => {
  for (const [text, expected] of [['/help', 'Как играть'], ['/play', 'открыть игру'], ['привет', 'только открывать']]) {
    const api = fakeApi();
    await handleUpdate(msg(text), { api, webAppUrl: URL_ });
    assert.ok(api.sent[0].text.includes(expected), text);
    assert.equal(api.sent[0].extra.reply_markup.inline_keyboard[0][0].web_app.url, URL_);
  }
});

test('игнорируются: группы, сообщения без текста, события без сообщения', async () => {
  const api = fakeApi();
  const group = { message: { chat: { id: 1, type: 'group' }, text: '/start' } };
  assert.equal(await handleUpdate(group, { api, webAppUrl: URL_ }), false);
  assert.equal(await handleUpdate({ message: { chat: { id: 1, type: 'private' }, sticker: {} } }, { api, webAppUrl: URL_ }), false);
  assert.equal(await handleUpdate({ callback_query: {} }, { api, webAppUrl: URL_ }), false);
  assert.equal(await handleUpdate(null, { api, webAppUrl: URL_ }), false);
  assert.equal(api.sent.length, 0);
});

test('secretMatches: верный проходит; неверный, пустой, отсутствующий, другой длины отклоняются', () => {
  assert.equal(secretMatches('abc123', 'abc123'), true);
  assert.equal(secretMatches('abc124', 'abc123'), false);
  assert.equal(secretMatches('', 'abc123'), false);
  assert.equal(secretMatches(undefined, 'abc123'), false);
  assert.equal(secretMatches('abc123456', 'abc123'), false);
  assert.equal(secretMatches('x', ''), false); // секрет не настроен: никого не пускаем
  assert.equal(secretMatches(['abc123'], 'abc123'), false);
});

test('isHttpsUrl: только https', () => {
  assert.equal(isHttpsUrl('https://a.b'), true);
  assert.equal(isHttpsUrl('http://a.b'), false);
  assert.equal(isHttpsUrl('a.b'), false);
  assert.equal(isHttpsUrl(''), false);
});

test('Bot API клиент: успех, ошибка без утечки токена, тело запроса', async () => {
  const calls = [];
  const ok = createTelegramApi('SECRET:TOKEN', {
    fetchImpl: async (url, init) => (calls.push({ url, body: JSON.parse(init.body) }), { json: async () => ({ ok: true, result: 42 }) }),
  });
  assert.equal(await ok.sendMessage(7, 'hi', { reply_markup: { x: 1 } }), 42);
  assert.equal(calls[0].url, 'https://api.telegram.org/botSECRET:TOKEN/sendMessage');
  assert.deepEqual(calls[0].body, { chat_id: 7, text: 'hi', parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { x: 1 } });

  const bad = createTelegramApi('SECRET:TOKEN', {
    fetchImpl: async () => ({ status: 403, json: async () => ({ ok: false, description: 'Forbidden: bot was blocked by the user' }) }),
  });
  await assert.rejects(() => bad.sendMessage(1, 'x'), (e) => {
    assert.ok(e.message.includes('blocked by the user'));
    assert.ok(!e.message.includes('SECRET'), 'токен не должен попадать в текст ошибки');
    return true;
  });
});

test('лимиты Telegram: описание ≤ 512, короткое ≤ 120, команды в нижнем регистре ≤ 32 символов', () => {
  assert.ok(BOT_DESCRIPTION.length <= 512, `описание ${BOT_DESCRIPTION.length}`);
  assert.ok(BOT_SHORT_DESCRIPTION.length <= 120, `короткое ${BOT_SHORT_DESCRIPTION.length}`);
  for (const c of COMMANDS) {
    assert.match(c.command, /^[a-z0-9_]{1,32}$/);
    assert.ok(c.description.length >= 3 && c.description.length <= 256);
  }
});

test('setupBot: команды, описания, кнопка меню; вебхук только по запросу', async () => {
  const calls = [];
  const api = { call: async (m, p) => calls.push([m, p]) };
  const done = await setupBot(api, { webAppUrl: URL_ });
  assert.deepEqual(calls.map((c) => c[0]), ['setMyCommands', 'setMyDescription', 'setMyShortDescription', 'setChatMenuButton']);
  assert.deepEqual(calls[3][1].menu_button, { type: 'web_app', text: 'Играть', web_app: { url: URL_ } });
  assert.ok(done.length >= 3);

  calls.length = 0;
  await setupBot(api, { webAppUrl: URL_, apiBaseUrl: 'https://api.example.com/', webhookSecret: 'sec' });
  const hook = calls.find((c) => c[0] === 'setWebhook')[1];
  assert.equal(hook.url, 'https://api.example.com/telegram/webhook');
  assert.equal(hook.secret_token, 'sec');
  assert.deepEqual(hook.allowed_updates, ['message']);
});

test('setupBot: отказывает на http-адресе и на вебхуке без секрета (ничего не вызывая)', async () => {
  const calls = [];
  const api = { call: async (m) => calls.push(m) };
  await assert.rejects(() => setupBot(api, { webAppUrl: 'http://x.y' }), /https/);
  await assert.rejects(() => setupBot(api, { webAppUrl: URL_, apiBaseUrl: 'https://a.b' }), /SECRET/);
  await assert.rejects(() => setupBot(api, { webAppUrl: URL_, apiBaseUrl: 'http://a.b', webhookSecret: 's' }), /https/);
});

test('upsertEnvLine: замена, добавление, сохранение остальных строк и переносов Windows', () => {
  assert.equal(upsertEnvLine('A=1\nWEBAPP_URL=old\nB=2\n', 'WEBAPP_URL', 'new'), 'A=1\nWEBAPP_URL=new\nB=2\n');
  assert.equal(upsertEnvLine('A=1\nB=2\n', 'WEBAPP_URL', 'x'), 'A=1\nB=2\nWEBAPP_URL=x\n');
  assert.equal(upsertEnvLine('A=1\nB=2', 'WEBAPP_URL', 'x'), 'A=1\nB=2\nWEBAPP_URL=x');
  assert.equal(upsertEnvLine('A=1\r\nWEBAPP_URL=old\r\n', 'WEBAPP_URL', 'new'), 'A=1\r\nWEBAPP_URL=new\r\n');
  assert.equal(upsertEnvLine('', 'K', 'v'), 'K=v\n'); // новый файл заканчивается переводом строки
  assert.equal(upsertEnvLine('WEBAPP_URL_OTHER=1\n', 'WEBAPP_URL', 'x'), 'WEBAPP_URL_OTHER=1\nWEBAPP_URL=x\n');
});
