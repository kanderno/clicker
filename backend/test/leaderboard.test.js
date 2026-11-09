import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLeaderboard } from '../src/leaderboard.js';

const leagues = [
  { id: 2, name: 'Серебро', min_peak: '10000', reward_1: 2000, reward_2: 1200, reward_3: 600 },
  { id: 1, name: 'Бронза', min_peak: 0, reward_1: 500, reward_2: 300, reward_3: 150 },
];

test('buildLeaderboard: лига по пику, до следующей лиги, места по порядку', () => {
  const rows = [
    { scope: 'global', place: '2', user_id: 7, username: 'me', balance: '900' },
    { scope: 'global', place: '1', user_id: 3, username: 'top', balance: '50000' },
    { scope: 'league', place: '1', user_id: 7, username: 'me', balance: '900' },
  ];
  const v = buildLeaderboard({ rows, leagues, myId: 7, peak: '2500' });
  assert.equal(v.league.name, 'Бронза');
  assert.equal(v.nextLeague.name, 'Серебро');
  assert.equal(v.coinsToNext, 7500);
  assert.deepEqual(v.global.map((p) => p.id), [3, 7]);
  assert.equal(v.global[1].isMe, true);
  assert.equal(v.global[0].balance, 50000);
  assert.deepEqual(v.leagues[1].rewards, [2000, 1200, 600]);
  assert.equal(v.local.length, 1);
});

test('buildLeaderboard: в последней лиге следующей нет', () => {
  const v = buildLeaderboard({ rows: [], leagues, myId: 1, peak: 99999 });
  assert.equal(v.league.name, 'Серебро');
  assert.equal(v.nextLeague, null);
  assert.equal(v.coinsToNext, null);
});
