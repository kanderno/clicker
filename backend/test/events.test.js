import test from 'node:test';
import assert from 'node:assert/strict';
import { listEventsWithOptions } from '../src/events.js';

// Минимальная подделка клиента Supabase: цепочка вызовов, которая "await"-ится.
function fakeClient(tables, failTable = null) {
  return {
    from(name) {
      let rows = [...tables[name]];
      const b = {
        select: () => b,
        order: (col, { ascending = true } = {}) => {
          rows.sort((x, y) => (x[col] > y[col] ? 1 : x[col] < y[col] ? -1 : 0) * (ascending ? 1 : -1));
          return b;
        },
        limit: (n) => ((rows = rows.slice(0, n)), b),
        in: (col, vals) => ((rows = rows.filter((r) => vals.includes(r[col]))), b),
        then: (res) => res(name === failTable ? { data: null, error: { message: 'boom' } } : { data: rows, error: null }),
      };
      return b;
    },
  };
}

const tables = {
  events: [
    { id: 1, title: 'A', created_at: '2026-01-01' },
    { id: 2, title: 'B', created_at: '2026-01-02', status: 'open' },
  ],
  event_options: [
    { id: 11, event_id: 1, title: 'Нет', pool: 0, position: 2 },
    { id: 10, event_id: 1, title: 'Да', pool: 5, position: 1 },
    { id: 20, event_id: 2, title: 'X', pool: 0, position: 1 },
    { id: 21, event_id: 2, title: 'Y', pool: 0, position: 2 },
  ],
};

test('варианты привязаны к своим событиям и отсортированы по position', async () => {
  const { events, error } = await listEventsWithOptions(fakeClient(tables));
  assert.equal(error, undefined);
  assert.deepEqual(events.map((e) => e.id), [2, 1]); // новые сверху
  assert.deepEqual(events[1].options.map((o) => o.title), ['Да', 'Нет']);
  assert.equal(events[0].options.length, 2);
  assert.equal('event_id' in events[1].options[0], false);
});

test('пустой список событий', async () => {
  const { events } = await listEventsWithOptions(fakeClient({ events: [], event_options: [] }));
  assert.deepEqual(events, []);
});

test('ошибка БД возвращается как error', async () => {
  assert.ok((await listEventsWithOptions(fakeClient(tables, 'events'))).error);
  assert.ok((await listEventsWithOptions(fakeClient(tables, 'event_options'))).error);
});

import { toPlayerView } from '../src/events.js';

test('toPlayerView: множители, пул, моя ставка, статус ставок', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  const events = [
    { id: 1, title: 'A', description: null, deadline: '2026-10-11T00:00:00Z',
      options: [{ id: 1, title: 'Да', pool: 300 }, { id: 2, title: 'Нет', pool: 100 }] },
    { id: 2, title: 'B', description: 'd', deadline: '2026-10-10T11:00:00Z',
      options: [{ id: 3, title: 'X', pool: 0 }, { id: 4, title: 'Y', pool: 0 }] },
  ];
  const mine = new Map([[1, { optionId: 1, amount: 50 }]]);
  const [a, b] = toPlayerView(events, mine, now);

  assert.equal(a.totalPool, 400);
  assert.deepEqual(a.options.map((o) => o.multiplier), [1.33, 4]); // 400/300, 400/100
  assert.equal(a.bettingOpen, true);
  assert.deepEqual(a.myBet, { optionId: 1, amount: 50 });

  assert.equal(b.bettingOpen, false);            // дедлайн прошёл
  assert.equal(b.myBet, null);
  assert.deepEqual(b.options.map((o) => o.multiplier), [null, null]); // пустые пулы, без деления на 0
});

test('toPlayerView: пулы из БД (bigint строкой) приводятся к числу', () => {
  const [e] = toPlayerView(
    [{ id: 1, title: 'A', deadline: '2030-01-01T00:00:00Z', options: [{ id: 1, title: 'x', pool: '250' }] }],
    new Map(),
  );
  assert.equal(e.totalPool, 250);
  assert.equal(e.options[0].pool, 250);
  assert.equal(e.options[0].multiplier, 1);
});

import { toMyBetsView } from '../src/events.js';

test('toMyBetsView: ожидание, победа, проигрыш, возврат, отмена', () => {
  const events = new Map([
    [1, { id: 1, title: 'Открыто', status: 'open', winning_option_id: null, refunded: false }],
    [2, { id: 2, title: 'Победа', status: 'resolved', winning_option_id: 20, refunded: false }],
    [3, { id: 3, title: 'Проигрыш', status: 'resolved', winning_option_id: 31, refunded: false }],
    [4, { id: 4, title: 'Возврат', status: 'resolved', winning_option_id: 42, refunded: true }],
    [5, { id: 5, title: 'Отмена', status: 'cancelled', winning_option_id: null, refunded: true }],
  ]);
  const options = new Map([[10, { title: 'A' }], [20, { title: 'B' }], [30, { title: 'C' }], [31, { title: 'D' }], [40, { title: 'E' }], [42, { title: 'F' }], [50, { title: 'G' }]]);
  const bets = [
    { id: 1, event_id: 1, option_id: 10, amount: 100, payout: null },
    { id: 2, event_id: 2, option_id: 20, amount: '100', payout: '250' },
    { id: 3, event_id: 3, option_id: 30, amount: 100, payout: 0 },
    { id: 4, event_id: 4, option_id: 40, amount: 100, payout: 100 },
    { id: 5, event_id: 5, option_id: 50, amount: 70, payout: 70 },
  ];
  const v = toMyBetsView(bets, events, options);
  assert.deepEqual(v.map((x) => x.result), ['pending', 'won', 'lost', 'refunded', 'refunded']);
  assert.equal(v[1].profit, 150);
  assert.equal(v[1].winningOptionTitle, 'B');
  assert.equal(v[2].profit, -100);
  assert.equal(v[3].profit, 0);
  assert.equal(v[0].profit, null);
});

test('toMyBetsView: удалённое событие не ломает список', () => {
  const [v] = toMyBetsView([{ id: 1, event_id: 9, option_id: 1, amount: 5, payout: null }], new Map(), new Map());
  assert.equal(v.result, 'pending');
  assert.equal(v.optionTitle, '');
});

test('toMyBetsView: бесплатные ставки: прибыль и убыток считаются от настоящих монет', () => {
  const events = new Map([
    [1, { id: 1, title: 'W', status: 'resolved', winning_option_id: 10, refunded: false }],
    [2, { id: 2, title: 'L', status: 'resolved', winning_option_id: 21, refunded: false }],
    [3, { id: 3, title: 'R', status: 'resolved', winning_option_id: 32, refunded: true }],
    [4, { id: 4, title: 'M', status: 'resolved', winning_option_id: 40, refunded: false }],
  ]);
  const options = new Map([[10, { title: 'A' }], [20, { title: 'B' }], [21, { title: 'C' }], [30, { title: 'D' }], [32, { title: 'E' }], [40, { title: 'F' }]]);
  const v = toMyBetsView(
    [
      { id: 1, event_id: 1, option_id: 10, amount: 100, free_amount: 100, payout: 200 }, // только бесплатная, выиграла
      { id: 2, event_id: 2, option_id: 20, amount: 100, free_amount: 100, payout: 0 },   // только бесплатная, проиграла
      { id: 3, event_id: 3, option_id: 30, amount: 150, free_amount: 100, payout: 50 },  // возврат: вернулись только свои 50
      { id: 4, event_id: 4, option_id: 40, amount: 150, free_amount: 100, payout: 300 }, // смесь, выиграла: свои 50 -> 300
    ],
    events,
    options,
  );
  assert.deepEqual(v.map((x) => x.result), ['won', 'lost', 'refunded', 'won']);
  assert.deepEqual(v.map((x) => x.cashAmount), [0, 0, 50, 50]);
  assert.deepEqual(v.map((x) => x.profit), [200, 0, 0, 250]);
  assert.deepEqual(v.map((x) => x.freeAmount), [100, 100, 100, 100]);
});

test('toMyBetsView: без поля free_amount (старые данные) считается как 0', () => {
  const [v] = toMyBetsView(
    [{ id: 1, event_id: 1, option_id: 1, amount: 80, payout: 160 }],
    new Map([[1, { id: 1, title: 'x', status: 'resolved', winning_option_id: 1, refunded: false }]]),
    new Map([[1, { title: 'A' }]]),
  );
  assert.equal(v.freeAmount, 0);
  assert.equal(v.profit, 80);
});
