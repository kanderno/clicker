import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanEcoMedia, ecoFilePath, ecoReportView } from '../src/eco.js';

test('ecoFilePath: имя придумывает сервер, только разрешённые типы', () => {
  assert.match(ecoFilePath(7, 'video/quicktime'), /^7\/[0-9a-f-]{36}\.mov$/);
  assert.match(ecoFilePath(7, 'image/jpeg'), /^7\/[0-9a-f-]{36}\.jpg$/);
  assert.equal(ecoFilePath(7, 'image/svg+xml'), null);
  assert.equal(ecoFilePath(7, 'text/html'), null);
  assert.equal(ecoFilePath(0, 'image/png'), null);
});

test('cleanEcoMedia: только свои файлы, без повторов, mime из расширения', () => {
  const a = ecoFilePath(5, 'image/png');
  const b = ecoFilePath(5, 'video/mp4');
  assert.deepEqual(cleanEcoMedia(5, [{ path: a, mime: 'text/html' }, { path: b }]), [
    { path: a, mime: 'image/png' },
    { path: b, mime: 'video/mp4' },
  ]);
  assert.equal(cleanEcoMedia(6, [{ path: a }]), null, 'чужой файл');
  assert.equal(cleanEcoMedia(5, [{ path: a }, { path: a }]), null, 'повтор');
  assert.equal(cleanEcoMedia(5, [{ path: '5/../1/x.png' }]), null);
  assert.equal(cleanEcoMedia(5, [{ path: a.replace('.png', '.exe') }]), null);
  assert.equal(cleanEcoMedia(5, []), null);
  assert.equal(cleanEcoMedia(5, Array.from({ length: 6 }, () => ({ path: ecoFilePath(5, 'image/png') }))), null);
  assert.equal(cleanEcoMedia(5, 'x'), null);
});

test('ecoReportView: ссылки на файлы и числа', () => {
  const row = {
    id: 1, description: 'убрал мусор', status: 'approved', reward: '1000', reviewer_name: 'Ilyas Upushev',
    review_comment: null, created_at: 't', reviewed_at: 't2', media: [{ path: '1/a.jpg', mime: 'image/jpeg' }],
  };
  const v = ecoReportView(row, new Map([['1/a.jpg', 'https://x/a']]));
  assert.equal(v.reward, 1000);
  assert.deepEqual(v.media, [{ mime: 'image/jpeg', url: 'https://x/a' }]);
  assert.equal('user' in v, false);
  assert.equal(ecoReportView(row, new Map(), null).media[0].url, null);
});
