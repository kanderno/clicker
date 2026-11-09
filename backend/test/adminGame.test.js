import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_STREAK, isImageUrl, settingsView, validateSettings } from '../src/adminGame.js';

test('settingsView: значения из базы поверх значений по умолчанию', () => {
  const v = settingsView([{ key: 'wheel_price', value: 300 }, { key: 'logo_url', value: '/img/5' }]);
  assert.equal(v.wheel_price, 300);
  assert.equal(v.steal_price, 1000);
  assert.equal(v.logo_url, '/img/5');
  assert.equal(v.coin_url, null);
  assert.deepEqual(v.streak_rewards, DEFAULT_STREAK);
});

test('validateSettings: числа в границах, лишние ключи и дроби запрещены', () => {
  const cur = settingsView([]);
  assert.deepEqual(validateSettings({ wheel_price: 200, tap_upgrade_growth: 1.5 }, cur).rows.length, 2);
  assert.equal(validateSettings({ wheel_price: 0 }, cur).error, 'bad_setting');
  assert.equal(validateSettings({ wheel_price: 1.5 }, cur).error, 'bad_setting');
  assert.equal(validateSettings({ wheel_price: '100' }, cur).error, 'bad_setting');
  assert.equal(validateSettings({ hack: 1 }, cur).error, 'bad_setting');
  assert.equal(validateSettings([], cur).error, 'bad_settings');
});

test('validateSettings: процент кражи min не больше max', () => {
  const cur = settingsView([]);
  assert.equal(validateSettings({ steal_pct_min: 20 }, cur).key, 'steal_pct_min');
  assert.ok(validateSettings({ steal_pct_min: 20, steal_pct_max: 30 }, cur).rows);
});

test('validateSettings: награды стрика чистятся, мусор отклоняется', () => {
  const cur = settingsView([]);
  const r = validateSettings({ streak_rewards: [{ coins: 10, spins: 0 }, { steals: 1 }] }, cur);
  assert.deepEqual(r.rows[0].value, [{ coins: 10 }, { steals: 1 }]);
  assert.equal(validateSettings({ streak_rewards: [] }, cur).error, 'bad_setting');
  assert.equal(validateSettings({ streak_rewards: [{ coins: -1 }] }, cur).error, 'bad_setting');
  assert.equal(validateSettings({ streak_rewards: [{ spins: 1000 }] }, cur).error, 'bad_setting');
});

test('isImageUrl: только наши /img/N или https', () => {
  assert.ok(isImageUrl('/img/12'));
  assert.ok(isImageUrl('https://example.com/a.png'));
  assert.ok(isImageUrl(null));
  assert.ok(!isImageUrl('javascript:alert(1)'));
  assert.ok(!isImageUrl('http://x.com/a.png'));
  assert.ok(!isImageUrl('/img/../x'));
});
