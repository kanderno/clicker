import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { config } from './config.js';
import { supabase } from './db.js';
import { validateInitData } from './telegram.js';
import { listEventsWithOptions, toMyBetsView, toPlayerView } from './events.js';
import { buildMinersView } from './miners.js';
import { createTelegramApi, handleUpdate, isHttpsUrl, secretMatches } from './bot.js';

const app = Fastify({ logger: true, trustProxy: true });

await app.register(cors, { origin: config.origins.length ? config.origins : false });
await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
await app.register(jwt, { secret: config.jwtSecret, sign: { expiresIn: '7d' } });

// Все эндпоинты, кроме /auth и /health, подключают этот хук.
app.decorate('authenticate', async (req, reply) => {
  try {
    await req.jwtVerify();
  } catch {
    return reply.code(401).send({ error: 'unauthorized' });
  }
});

// Только для админов (ID берётся из подписанного JWT, а не из запроса).
app.decorate('requireAdmin', async (req, reply) => {
  if (!config.adminIds.includes(req.user.tg)) {
    return reply.code(403).send({ error: 'forbidden' });
  }
});

const USER_FIELDS = 'id, telegram_id, username, first_name, balance';

app.get('/health', async () => ({ ok: true, time: new Date().toISOString() }));

app.post(
  '/auth',
  {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['initData'],
        properties: { initData: { type: 'string', minLength: 1, maxLength: 4096 } },
      },
    },
  },
  async (req, reply) => {
    const result = validateInitData(req.body.initData, config.botToken);
    if (!result) return reply.code(401).send({ error: 'invalid_init_data' });

    const { user: tg } = result;

    // Upsert без поля balance: у существующего игрока баланс не трогаем.
    const { data, error } = await supabase
      .from('users')
      .upsert(
        {
          telegram_id: tg.id,
          username: tg.username ?? null,
          first_name: tg.first_name ?? null,
        },
        { onConflict: 'telegram_id' },
      )
      .select(USER_FIELDS)
      .single();

    if (error) {
      req.log.error(error, 'users upsert failed');
      return reply.code(500).send({ error: 'db_error' });
    }

    const token = app.jwt.sign({ uid: data.id, tg: data.telegram_id });
    return { token, user: data, isAdmin: config.adminIds.includes(data.telegram_id) };
  },
);

app.get('/me', { preHandler: app.authenticate }, async (req, reply) => {
  const { data, error } = await supabase
    .from('users')
    .select(USER_FIELDS)
    .eq('id', req.user.uid)
    .single();

  if (error || !data) return reply.code(404).send({ error: 'user_not_found' });
  return { user: data, isAdmin: config.adminIds.includes(data.telegram_id) };
});

app.post(
  '/tap',
  {
    preHandler: app.authenticate,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['count'],
        properties: { count: { type: 'integer', minimum: 1, maximum: 1000000 } },
      },
    },
  },
  async (req, reply) => {
    // Лимит 15 кликов/сек считается внутри SQL-функции apply_taps (атомарно).
    const { data, error } = await supabase.rpc('apply_taps', {
      p_user: req.user.uid,
      p_count: req.body.count,
    });
    if (error || !data?.length) {
      req.log.error(error, 'apply_taps failed');
      return reply.code(500).send({ error: 'db_error' });
    }
    return { balance: data[0].new_balance, accepted: data[0].accepted };
  },
);

// ---------- Банк ----------
const BANK_ERRORS = ['insufficient_funds', 'bad_amount', 'user_not_found'];
function bankFail(req, reply, error) {
  const code = BANK_ERRORS.find((c) => error?.message?.includes(c));
  if (code) return reply.code(400).send({ error: code });
  req.log.error(error, 'bank rpc failed');
  return reply.code(500).send({ error: 'db_error' });
}

const amountBody = {
  type: 'object',
  required: ['amount'],
  properties: { amount: { type: 'integer', minimum: 1, maximum: 1000000000000 } },
};
const bankLimit = { rateLimit: { max: 60, timeWindow: '1 minute' } };

app.get('/bank/state', { preHandler: app.authenticate, config: bankLimit }, async (req, reply) => {
  const { data, error } = await supabase.rpc('bank_state', { p_user: req.user.uid });
  if (error || !data?.length) return bankFail(req, reply, error);
  const r = data[0];
  return {
    wallet: r.wallet_balance,
    savings: r.savings_balance,
    hourlyGain: r.hourly_gain,
    ratePerHour: r.rate_per_hour,
    maxHours: r.max_hours,
  };
});

for (const [path, fn] of [['/bank/deposit', 'bank_deposit'], ['/bank/withdraw', 'bank_withdraw']]) {
  app.post(
    path,
    { preHandler: app.authenticate, config: bankLimit, schema: { body: amountBody } },
    async (req, reply) => {
      const { data, error } = await supabase.rpc(fn, { p_user: req.user.uid, p_amount: req.body.amount });
      if (error || !data?.length) return bankFail(req, reply, error);
      return { wallet: data[0].wallet_balance, savings: data[0].savings_balance };
    },
  );
}

// ---------- Telegram-бот: приветствие (вебхук) ----------
if (config.webhookSecret && isHttpsUrl(config.webAppUrl)) {
  const tg = createTelegramApi(config.botToken, { base: config.telegramApiBase });
  app.post('/telegram/webhook', { config: { rateLimit: false } }, async (req, reply) => {
    // Принимаем только запросы с секретом, который мы сами передали Telegram при setWebhook
    if (!secretMatches(req.headers['x-telegram-bot-api-secret-token'], config.webhookSecret)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    try {
      await handleUpdate(req.body, { api: tg, webAppUrl: config.webAppUrl });
    } catch (err) {
      // Всегда отвечаем 200, иначе Telegram будет бесконечно повторять то же сообщение
      req.log.error({ err: err.message }, 'telegram update failed');
    }
    return { ok: true };
  });
} else {
  app.log.info('Вебхук Telegram выключен (нужны WEBAPP_URL с https и TELEGRAM_WEBHOOK_SECRET)');
}

// ---------- Майнеры ----------
const MINER_ERRORS = [
  'not_enough_parts', 'max_level', 'insufficient_funds', 'miner_limit',
  'bad_type', 'miner_not_found', 'bad_part', 'bad_qty', 'user_not_found',
];
const minerLimit = { rateLimit: { max: 60, timeWindow: '1 minute' } };
function minerFail(req, reply, error, what) {
  const code = MINER_ERRORS.find((c) => error?.message?.includes(c));
  if (code) return reply.code(400).send({ error: code });
  req.log.error(error, what);
  return reply.code(500).send({ error: 'db_error' });
}

app.get('/miners', { preHandler: app.authenticate, config: minerLimit }, async (req, reply) => {
  const uid = req.user.uid;
  const [me, parts, inv, types, recipes, overview, cfg] = await Promise.all([
    supabase.from('users').select('balance').eq('id', uid).single(),
    supabase.from('part_types').select('id, code, name, shop_price').order('sort'),
    supabase.from('parts_inventory').select('part_type_id, qty').eq('user_id', uid),
    supabase.from('miner_types').select('id, code, name, base_income, max_level').eq('active', true).order('sort'),
    supabase.from('miner_recipes').select('miner_type_id, part_type_id, qty'),
    supabase.rpc('miners_overview', { p_user: uid }),
    supabase.rpc('miners_config'),
  ]);
  const failed = [me, parts, inv, types, recipes, overview, cfg].find((r) => r.error);
  if (failed || !cfg.data?.length) return minerFail(req, reply, failed?.error, 'miners view failed');

  return buildMinersView({
    balance: me.data.balance,
    parts: parts.data,
    inventory: inv.data,
    types: types.data,
    recipes: recipes.data,
    overview: overview.data,
    config: cfg.data[0],
  });
});

app.post(
  '/miners/build',
  {
    preHandler: app.authenticate,
    config: minerLimit,
    schema: { body: { type: 'object', required: ['typeId'], properties: { typeId: { type: 'integer', minimum: 1 } } } },
  },
  async (req, reply) => {
    const { data, error } = await supabase.rpc('miner_build', { p_user: req.user.uid, p_type: req.body.typeId });
    if (error || !data?.length) return minerFail(req, reply, error, 'miner_build failed');
    return { minerId: data[0].new_miner_id };
  },
);

app.post(
  '/miners/collect',
  { preHandler: app.authenticate, config: minerLimit },
  async (req, reply) => {
    const { data, error } = await supabase.rpc('miners_collect', { p_user: req.user.uid });
    if (error || !data?.length) return minerFail(req, reply, error, 'miners_collect failed');
    return { collected: data[0].collected, balance: data[0].new_balance };
  },
);

app.post(
  '/miners/:id/upgrade',
  {
    preHandler: app.authenticate,
    config: minerLimit,
    schema: { params: { type: 'object', properties: { id: { type: 'integer', minimum: 1 } } } },
  },
  async (req, reply) => {
    const { data, error } = await supabase.rpc('miner_upgrade', { p_user: req.user.uid, p_miner: req.params.id });
    if (error || !data?.length) return minerFail(req, reply, error, 'miner_upgrade failed');
    return { balance: data[0].new_balance, level: data[0].new_level, paid: data[0].paid };
  },
);

app.post(
  '/parts/buy',
  {
    preHandler: app.authenticate,
    config: minerLimit,
    schema: {
      body: {
        type: 'object',
        required: ['partId', 'qty'],
        properties: {
          partId: { type: 'integer', minimum: 1 },
          qty: { type: 'integer', minimum: 1, maximum: 100 },
        },
      },
    },
  },
  async (req, reply) => {
    const { data, error } = await supabase.rpc('part_buy', {
      p_user: req.user.uid,
      p_part: req.body.partId,
      p_qty: req.body.qty,
    });
    if (error || !data?.length) return minerFail(req, reply, error, 'part_buy failed');
    return { balance: data[0].new_balance, qty: data[0].new_qty };
  },
);

// ---------- Колесо фортуны ----------
const WHEEL_ERRORS = ['free_spin_used', 'paid_limit', 'insufficient_funds', 'user_not_found', 'bad_mode'];
const wheelLimit = { rateLimit: { max: 30, timeWindow: '1 minute' } };

app.get('/wheel', { preHandler: app.authenticate, config: wheelLimit }, async (req, reply) => {
  const [stateRes, prizesRes] = await Promise.all([
    supabase.rpc('wheel_state', { p_user: req.user.uid }),
    // Веса (шансы) игроку не отдаём: только то, что нужно для отрисовки секторов.
    supabase.from('prizes').select('id, kind, value, label').eq('active', true).order('sort').order('id'),
  ]);
  if (stateRes.error || !stateRes.data?.length || prizesRes.error) {
    req.log.error(stateRes.error || prizesRes.error, 'wheel state failed');
    return reply.code(500).send({ error: 'db_error' });
  }
  const st = stateRes.data[0];
  return {
    freeAvailable: st.free_available,
    paidToday: st.paid_today,
    paidMax: st.paid_max,
    price: st.price,
    secondsToReset: st.seconds_to_reset,
    prizes: prizesRes.data,
  };
});

app.post(
  '/wheel/spin',
  {
    preHandler: app.authenticate,
    config: wheelLimit,
    schema: {
      body: {
        type: 'object',
        required: ['mode'],
        properties: { mode: { type: 'string', enum: ['free', 'paid'] } },
      },
    },
  },
  async (req, reply) => {
    // Приз выбирается на сервере (SQL, криптостойкий рандом). Клиент только анимирует присланный результат.
    const { data, error } = await supabase.rpc('wheel_spin', { p_user: req.user.uid, p_mode: req.body.mode });
    if (error || !data?.length) {
      const code = WHEEL_ERRORS.find((c) => error?.message?.includes(c));
      if (code) return reply.code(400).send({ error: code });
      req.log.error(error, 'wheel_spin failed');
      return reply.code(500).send({ error: 'db_error' });
    }
    const r = data[0];
    return {
      prize: { id: r.prize_id, label: r.prize_label, kind: r.prize_kind, value: r.prize_value },
      balance: r.new_balance,
      wasFree: r.was_free,
    };
  },
);

// ---------- Уведомления о кражах ----------
// Жертва должна узнать, куда пропали монеты. Вор остаётся анонимным.
app.get('/steals/unseen', { preHandler: app.authenticate }, async (req, reply) => {
  const [stealsRes, meRes] = await Promise.all([
    supabase
      .from('steals')
      .select('id, amount, created_at')
      .eq('victim_id', req.user.uid)
      .eq('seen', false)
      .order('id', { ascending: true })
      .limit(50),
    supabase.from('users').select('balance').eq('id', req.user.uid).single(),
  ]);
  if (stealsRes.error || meRes.error) {
    req.log.error(stealsRes.error || meRes.error, 'unseen steals failed');
    return reply.code(500).send({ error: 'db_error' });
  }
  return { balance: meRes.data.balance, steals: stealsRes.data };
});

// Помечаем прочитанными только то, что игрок реально увидел (id <= upToId): кражи, случившиеся позже, не теряются.
app.post(
  '/steals/seen',
  {
    preHandler: app.authenticate,
    schema: {
      body: { type: 'object', required: ['upToId'], properties: { upToId: { type: 'integer', minimum: 1 } } },
    },
  },
  async (req, reply) => {
    const { error } = await supabase
      .from('steals')
      .update({ seen: true })
      .eq('victim_id', req.user.uid)
      .eq('seen', false)
      .lte('id', req.body.upToId);
    if (error) {
      req.log.error(error, 'mark steals seen failed');
      return reply.code(500).send({ error: 'db_error' });
    }
    return { ok: true };
  },
);

// ---------- Предсказания (для игроков) ----------
const BET_ERRORS = [
  'event_closed', 'event_not_found', 'bad_option', 'insufficient_funds',
  'other_option', 'bad_amount', 'user_not_found',
];

// Ставки и пулы видны всем. Множитель только для отображения: итоговая выплата считается при закрытии.
app.get('/events', { preHandler: app.authenticate }, async (req, reply) => {
  const { events, error } = await listEventsWithOptions(supabase, {
    statuses: ['open'],
    orderBy: 'deadline',
    ascending: true,
  });
  if (error) {
    req.log.error(error, 'events list failed');
    return reply.code(500).send({ error: 'db_error' });
  }

  const mine = new Map();
  if (events.length) {
    const { data: bets, error: betsErr } = await supabase
      .from('bets')
      .select('event_id, option_id, amount, free_amount')
      .eq('user_id', req.user.uid)
      .in('event_id', events.map((e) => e.id));
    if (betsErr) {
      req.log.error(betsErr, 'my bets failed');
      return reply.code(500).send({ error: 'db_error' });
    }
    for (const b of bets) {
      mine.set(b.event_id, { optionId: b.option_id, amount: b.amount, freeAmount: b.free_amount });
    }
  }

  return { events: toPlayerView(events, mine) };
});

app.post(
  '/bet',
  {
    preHandler: app.authenticate,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['eventId', 'optionId', 'amount'],
        properties: {
          eventId: { type: 'integer', minimum: 1 },
          optionId: { type: 'integer', minimum: 1 },
          amount: { type: 'integer', minimum: 1, maximum: 1000000000000 },
        },
      },
    },
  },
  async (req, reply) => {
    // Дедлайн, баланс, списание, ставка, пул: всё внутри SQL-функции place_bet, одной транзакцией.
    const { eventId, optionId, amount } = req.body;
    const { data, error } = await supabase.rpc('place_bet', {
      p_user: req.user.uid,
      p_event: eventId,
      p_option: optionId,
      p_amount: amount,
    });
    if (error || !data?.length) {
      const code = BET_ERRORS.find((c) => error?.message?.includes(c));
      if (code) return reply.code(400).send({ error: code });
      req.log.error(error, 'place_bet failed');
      return reply.code(500).send({ error: 'db_error' });
    }
    return { balance: data[0].new_balance, myStake: data[0].my_stake, optionPool: data[0].option_pool };
  },
);

// ---------- Бесплатные ставки ----------
app.get('/free-bets', { preHandler: app.authenticate }, async (req, reply) => {
  const { data, error } = await supabase
    .from('free_bets')
    .select('id, amount, created_at')
    .eq('user_id', req.user.uid)
    .eq('status', 'available')
    .order('id', { ascending: true });
  if (error) {
    req.log.error(error, 'free bets list failed');
    return reply.code(500).send({ error: 'db_error' });
  }
  return { freeBets: data };
});

app.post(
  '/bet/free',
  {
    preHandler: app.authenticate,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['eventId', 'optionId', 'freeBetId'],
        properties: {
          eventId: { type: 'integer', minimum: 1 },
          optionId: { type: 'integer', minimum: 1 },
          freeBetId: { type: 'integer', minimum: 1 },
        },
      },
    },
  },
  async (req, reply) => {
    // Монеты игрока не списываются: бесплатная часть идёт в пул за счёт казино. Всё в одной транзакции SQL.
    const { eventId, optionId, freeBetId } = req.body;
    const { data, error } = await supabase.rpc('place_free_bet', {
      p_user: req.user.uid,
      p_event: eventId,
      p_option: optionId,
      p_free_bet: freeBetId,
    });
    if (error || !data?.length) {
      const code = [...BET_ERRORS, 'free_bet_unavailable'].find((c) => error?.message?.includes(c));
      if (code) return reply.code(400).send({ error: code });
      req.log.error(error, 'place_free_bet failed');
      return reply.code(500).send({ error: 'db_error' });
    }
    return { myStake: data[0].my_stake, optionPool: data[0].option_pool, myFree: data[0].my_free };
  },
);

app.get('/bets/mine', { preHandler: app.authenticate }, async (req, reply) => {
  const fail = (error, what) => {
    req.log.error(error, what);
    return reply.code(500).send({ error: 'db_error' });
  };

  const { data: bets, error } = await supabase
    .from('bets')
    .select('id, event_id, option_id, amount, free_amount, payout')
    .eq('user_id', req.user.uid)
    .order('id', { ascending: false })
    .limit(30);
  if (error) return fail(error, 'my bets failed');

  const { data: me, error: meErr } = await supabase.from('users').select('balance').eq('id', req.user.uid).single();
  if (meErr) return fail(meErr, 'balance failed');
  if (!bets.length) return { balance: me.balance, bets: [] };

  const { data: events, error: evErr } = await supabase
    .from('events')
    .select('id, title, status, winning_option_id, refunded')
    .in('id', [...new Set(bets.map((b) => b.event_id))]);
  if (evErr) return fail(evErr, 'my bets events failed');

  const optionIds = new Set(bets.map((b) => b.option_id));
  for (const e of events) if (e.winning_option_id) optionIds.add(e.winning_option_id);
  const { data: options, error: optErr } = await supabase
    .from('event_options')
    .select('id, title')
    .in('id', [...optionIds]);
  if (optErr) return fail(optErr, 'my bets options failed');

  return {
    balance: me.balance,
    bets: toMyBetsView(
      bets,
      new Map(events.map((e) => [e.id, e])),
      new Map(options.map((o) => [o.id, o])),
    ),
  };
});

// ---------- Админка: предсказания ----------
const adminOnly = [app.authenticate, app.requireAdmin];
const EVENT_ERRORS = ['bad_title', 'bad_options', 'bad_deadline', 'bad_odds', 'bad_mode'];

app.get('/admin/events', { preHandler: adminOnly }, async (req, reply) => {
  const { events, error } = await listEventsWithOptions(supabase);
  if (error) {
    req.log.error(error, 'admin events list failed');
    return reply.code(500).send({ error: 'db_error' });
  }
  return { events };
});

app.post(
  '/admin/events',
  {
    preHandler: adminOnly,
    schema: {
      body: {
        type: 'object',
        required: ['title', 'deadline', 'options'],
        properties: {
          title: { type: 'string', minLength: 3, maxLength: 200 },
          description: { type: 'string', maxLength: 1000 },
          deadline: { type: 'string', format: 'date-time' },
          options: { type: 'array', minItems: 2, maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 100 } },
          // 'pool' — тотализатор (как раньше), 'odds' — фиксированные коэффициенты
          payoutMode: { type: 'string', enum: ['pool', 'odds'] },
          // Коэффициенты: по одному на вариант, нужны только при payoutMode = 'odds'
          odds: { type: 'array', minItems: 2, maxItems: 10, items: { type: 'number', minimum: 1.01, maximum: 1000 } },
        },
      },
    },
  },
  async (req, reply) => {
    const { title, description, deadline, options, payoutMode = 'pool', odds } = req.body;
    // Длину массивов проверяет и SQL (bad_odds), здесь — чтобы не ходить в БД зря.
    if (payoutMode === 'odds' && (!odds || odds.length !== options.length)) {
      return reply.code(400).send({ error: 'bad_odds' });
    }
    const { data, error } = await supabase.rpc('admin_create_event', {
      p_title: title,
      p_description: description ?? null,
      p_deadline: deadline,
      p_options: options,
      p_mode: payoutMode,
      p_odds: payoutMode === 'odds' ? odds : null,
    });
    if (error) {
      const code = EVENT_ERRORS.find((c) => error.message?.includes(c));
      if (code) return reply.code(400).send({ error: code });
      req.log.error(error, 'admin_create_event failed');
      return reply.code(500).send({ error: 'db_error' });
    }
    return { id: data };
  },
);

// Закрытие события: выплаты или возврат считаются внутри SQL-функции одной транзакцией.
// Повторный вызов безопасен: changed = false, ничего не меняется.
const RESOLVE_ERRORS = ['bad_option', 'bad_odds', 'event_not_found'];
async function resolveEvent(req, reply, optionId) {
  const { data, error } = await supabase.rpc('admin_resolve_event', {
    p_event: req.params.id,
    p_option: optionId,
  });
  if (error || !data?.length) {
    const code = RESOLVE_ERRORS.find((c) => error?.message?.includes(c));
    if (code) return reply.code(code === 'event_not_found' ? 404 : 400).send({ error: code });
    req.log.error(error, 'admin_resolve_event failed');
    return reply.code(500).send({ error: 'db_error' });
  }
  const r = data[0];
  req.log.info({ event: req.params.id, optionId, admin: req.user.tg, changed: r.res_changed }, 'event resolved');
  return {
    changed: r.res_changed,
    status: r.res_status,
    refunded: r.res_refunded,
    totalPool: r.res_total,
    paidOut: r.res_paid,
  };
}
const idParams = { type: 'object', properties: { id: { type: 'integer', minimum: 1 } } };

app.post(
  '/admin/events/:id/resolve',
  {
    preHandler: adminOnly,
    schema: {
      params: idParams,
      body: {
        type: 'object',
        required: ['optionId'],
        properties: { optionId: { type: 'integer', minimum: 1 } },
      },
    },
  },
  (req, reply) => resolveEvent(req, reply, req.body.optionId),
);

app.post(
  '/admin/events/:id/cancel',
  { preHandler: adminOnly, schema: { params: idParams } },
  (req, reply) => resolveEvent(req, reply, null),
);

// Удалить можно только событие без ставок (защита целостности: FK без cascade).
app.delete(
  '/admin/events/:id',
  {
    preHandler: adminOnly,
    schema: { params: { type: 'object', properties: { id: { type: 'integer', minimum: 1 } } } },
  },
  async (req, reply) => {
    const { data, error } = await supabase.from('events').delete().eq('id', req.params.id).select('id');
    if (error) {
      if (error.code === '23503') return reply.code(409).send({ error: 'event_has_bets' });
      req.log.error(error, 'admin event delete failed');
      return reply.code(500).send({ error: 'db_error' });
    }
    if (!data?.length) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  },
);

// ---------- Админка: монеты игрокам ----------
const GRANT_ERRORS = ['bad_amount', 'bad_reason', 'user_not_found', 'admin_not_found', 'insufficient_funds'];

// Поиск игрока по имени, нику или Telegram ID. Без запроса — последние зарегистрировавшиеся.
app.get(
  '/admin/users',
  {
    preHandler: adminOnly,
    schema: {
      querystring: {
        type: 'object',
        properties: {
          q: { type: 'string', maxLength: 64 },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
        },
      },
    },
  },
  async (req, reply) => {
    // В фильтре PostgREST запятые и скобки — разделители, поэтому из запроса их вырезаем.
    const term = (req.query.q ?? '').trim().replace(/[%,()\\'"*]/g, '');
    let q = supabase
      .from('users')
      .select(USER_FIELDS)
      .order('id', { ascending: false })
      .limit(req.query.limit);
    if (term) {
      const filters = [`username.ilike.%${term}%`, `first_name.ilike.%${term}%`];
      if (/^\d+$/.test(term)) filters.push(`telegram_id.eq.${term}`);
      q = q.or(filters.join(','));
    }
    const { data, error } = await q;
    if (error) {
      req.log.error(error, 'admin users search failed');
      return reply.code(500).send({ error: 'db_error' });
    }
    return { users: data };
  },
);

// Начислить (amount > 0) или списать (amount < 0) монеты игроку.
// Всё внутри SQL-функции: баланс, запись в ledger и журнал начислений — одной транзакцией.
app.post(
  '/admin/users/:id/coins',
  {
    preHandler: adminOnly,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      params: idParams,
      body: {
        type: 'object',
        required: ['amount'],
        properties: {
          amount: { type: 'integer', minimum: -1000000000000, maximum: 1000000000000 },
          reason: { type: 'string', maxLength: 200 },
        },
      },
    },
  },
  async (req, reply) => {
    if (req.body.amount === 0) return reply.code(400).send({ error: 'bad_amount' });
    const { data, error } = await supabase.rpc('admin_grant_coins', {
      p_admin: req.user.uid,
      p_user: req.params.id,
      p_amount: req.body.amount,
      p_reason: req.body.reason ?? null,
    });
    if (error || !data?.length) {
      const code = GRANT_ERRORS.find((c) => error?.message?.includes(c));
      if (code) return reply.code(code === 'user_not_found' ? 404 : 400).send({ error: code });
      req.log.error(error, 'admin_grant_coins failed');
      return reply.code(500).send({ error: 'db_error' });
    }
    req.log.info(
      { admin: req.user.tg, user: req.params.id, amount: req.body.amount, grant: data[0].grant_id },
      'admin coins granted',
    );
    return { balance: data[0].new_balance, grantId: data[0].grant_id };
  },
);

// История ручных начислений: видно, кто и кому выдал монеты.
app.get('/admin/coins/history', { preHandler: adminOnly }, async (req, reply) => {
  const { data: grants, error } = await supabase
    .from('admin_grants')
    .select('id, admin_id, user_id, amount, reason, balance_after, created_at')
    .order('id', { ascending: false })
    .limit(30);
  if (error) {
    req.log.error(error, 'admin grants list failed');
    return reply.code(500).send({ error: 'db_error' });
  }
  if (!grants.length) return { grants: [] };

  // Два FK на users (admin_id и user_id): вложенный select PostgREST не разрешает, грузим отдельно.
  const ids = [...new Set(grants.flatMap((g) => [g.admin_id, g.user_id]))];
  const { data: users, error: uErr } = await supabase
    .from('users')
    .select('id, telegram_id, username, first_name')
    .in('id', ids);
  if (uErr) {
    req.log.error(uErr, 'admin grants users failed');
    return reply.code(500).send({ error: 'db_error' });
  }
  const byId = new Map(users.map((u) => [u.id, u]));
  return {
    grants: grants.map((g) => ({
      id: g.id,
      amount: Number(g.amount),
      reason: g.reason,
      balanceAfter: Number(g.balance_after),
      createdAt: g.created_at,
      admin: byId.get(g.admin_id) ?? null,
      user: byId.get(g.user_id) ?? null,
    })),
  };
});

// ---------- Mini App: раздача собранного фронтенда ----------
// В Docker фронт собирается в /usr/src/app/frontend/dist (вне /app, чтобы bind mount Bothost его не затёр).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(process.env.FRONTEND_DIST || path.join(__dirname, '../../frontend/dist'));
const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

if (fs.existsSync(path.join(distDir, 'index.html'))) {
  app.get('/', (req, reply) =>
    reply
      .header('Cache-Control', 'no-cache')
      .type(MIME['.html'])
      .send(fs.createReadStream(path.join(distDir, 'index.html'))),
  );

  app.get('/assets/*', async (req, reply) => {
    const assetsDir = path.join(distDir, 'assets');
    const file = path.resolve(assetsDir, req.params['*']);
    if (!file.startsWith(assetsDir + path.sep)) return reply.code(404).send({ error: 'not_found' });
    try {
      const stat = await fs.promises.stat(file);
      if (!stat.isFile()) return reply.code(404).send({ error: 'not_found' });
      return reply
        .header('Cache-Control', 'public, max-age=31536000, immutable')
        .type(MIME[path.extname(file).toLowerCase()] || 'application/octet-stream')
        .send(fs.createReadStream(file));
    } catch {
      return reply.code(404).send({ error: 'not_found' });
    }
  });

  app.log.info(`Mini App: ${distDir}`);
} else {
  app.log.warn(`Mini App не собрана: нет ${path.join(distDir, 'index.html')}`);
}

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
