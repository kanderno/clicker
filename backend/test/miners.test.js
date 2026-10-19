import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMinersView } from '../src/miners.js';

const parts = [
  { id: 1, code: 'bolt', name: 'Болт', shop_price: '60' },
  { id: 2, code: 'chip', name: 'Чип', shop_price: 180 },
];
const types = [
  { id: 10, code: 'mini', name: 'Мини-майнер', base_income: 20, max_level: 5 },
  { id: 11, code: 'big', name: 'Фабрика', base_income: 90, max_level: 8 },
];
const recipes = [
  { miner_type_id: 10, part_type_id: 1, qty: 3 },
  { miner_type_id: 10, part_type_id: 2, qty: 1 },
  { miner_type_id: 11, part_type_id: 1, qty: 6 },
  { miner_type_id: 11, part_type_id: 2, qty: 3 },
];
const config = { max_miners: 10, cap_hours: 2 };
const base = { balance: '500', parts, types, recipes, overview: [], config };

test('запас деталей и возможность сборки', () => {
  const v = buildMinersView({ ...base, inventory: [{ part_type_id: 1, qty: '4' }, { part_type_id: 2, qty: 1 }] });
  assert.equal(v.balance, 500);
  assert.deepEqual(v.parts.map((p) => [p.code, p.qty, p.shopPrice]), [['bolt', 4, 60], ['chip', 1, 180]]);
  const [mini, big] = v.types;
  assert.equal(mini.canBuild, true);            // 3 болта + 1 чип есть
  assert.equal(big.canBuild, false);            // нужно 6 болтов и 3 чипа
  assert.deepEqual(big.recipe.map((r) => [r.partName, r.qty, r.have]), [['Болт', 6, 4], ['Чип', 3, 1]]);
});

test('пустой запас: собрать нельзя ничего', () => {
  const v = buildMinersView({ ...base, inventory: [] });
  assert.ok(v.types.every((t) => !t.canBuild));
  assert.deepEqual(v.parts.map((p) => p.qty), [0, 0]);
});

test('майнеры игрока: числа приводятся к number, сумма накоплений, цена улучшения null на максимуме', () => {
  const v = buildMinersView({
    ...base,
    inventory: [],
    overview: [
      { miner_id: 1, type_id: 10, type_name: 'Мини-майнер', level: 2, max_level: 5, income_per_hour: '30', pending: '25', pending_max: '60', upgrade_cost: '255' },
      { miner_id: 2, type_id: 11, type_name: 'Фабрика', level: 8, max_level: 8, income_per_hour: 360, pending: 100, pending_max: 720, upgrade_cost: null },
    ],
  });
  assert.equal(v.pendingTotal, 125);
  assert.equal(v.miners[0].incomePerHour, 30);
  assert.equal(v.miners[0].upgradeCost, 255);
  assert.equal(v.miners[1].upgradeCost, null);
  assert.equal(v.capHours, 2);
});

test('лимит майнеров: при заполнении собрать нельзя, даже если детали есть', () => {
  const overview = Array.from({ length: 10 }, (_, i) => ({
    miner_id: i + 1, type_id: 10, type_name: 'Мини-майнер', level: 1, max_level: 5,
    income_per_hour: 20, pending: 0, pending_max: 40, upgrade_cost: 150,
  }));
  const v = buildMinersView({ ...base, overview, inventory: [{ part_type_id: 1, qty: 99 }, { part_type_id: 2, qty: 99 }] });
  assert.equal(v.canBuildMore, false);
  assert.ok(v.types.every((t) => !t.canBuild));
});

test('тип без рецепта собрать нельзя', () => {
  const v = buildMinersView({ ...base, recipes: [], inventory: [{ part_type_id: 1, qty: 99 }] });
  assert.ok(v.types.every((t) => !t.canBuild));
});
