import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCountdown, labelFontSize, nextRotation, sectorAtPointer, sectorPath } from './wheelMath.js';

test('колесо останавливается ровно на выбранном секторе: любое n, любой сектор, любой джиттер, любой старт', () => {
  let checked = 0;
  for (let n = 2; n <= 12; n++) {
    for (let i = 0; i < n; i++) {
      for (const jitter of [-1, -0.5, 0, 0.5, 1, 7, -7]) {
        for (const start of [0, 37.5, 359.9, 360, 1234.56, 99999]) {
          const rot = nextRotation(start, i, n, 5, jitter);
          assert.equal(sectorAtPointer(rot, n), i, `n=${n} i=${i} jitter=${jitter} start=${start}`);
          assert.ok(rot >= start + 5 * 360, 'минимум 5 оборотов вперёд');
          assert.ok(rot < start + 6 * 360 + 1e-9, 'не больше 6 оборотов');
          checked++;
        }
      }
    }
  }
  assert.equal(checked, 3234); // 77 секторов (n=2..12) x 7 джиттеров x 6 стартов
});

test('несколько спинов подряд: каждый раз попадаем в нужный сектор', () => {
  let rot = 0;
  const n = 6;
  for (const i of [3, 3, 0, 5, 1, 1, 4]) {
    rot = nextRotation(rot, i, n, 5, Math.random() * 2 - 1);
    assert.equal(sectorAtPointer(rot, n), i);
  }
});

test('форма сектора: путь начинается в центре и замкнут', () => {
  const d = sectorPath(0, 6, 150, 150, 140);
  assert.ok(d.startsWith('M 150 150 L '));
  assert.ok(d.endsWith('Z'));
  assert.ok(d.includes('A 140 140 0 0 1'));
});

test('таймер: формат ЧЧ:ММ:СС, отрицательные значения не ломают', () => {
  assert.equal(formatCountdown(0), '00:00:00');
  assert.equal(formatCountdown(3661), '01:01:01');
  assert.equal(formatCountdown(86399), '23:59:59');
  assert.equal(formatCountdown(-5), '00:00:00');
});

test('подписи секторов: шрифт в пределах 10–22 и текст не шире сектора (пока не упёрлись в минимум)', () => {
  for (let n = 3; n <= 14; n++) {
    const chord = 2 * 102 * Math.sin(Math.PI / n);
    for (let len = 1; len <= 10; len++) {
      const f = labelFontSize(len, n);
      assert.ok(f >= 10 && f <= 22, `n=${n} len=${len} f=${f}`);
      if (f > 10) assert.ok(len * 0.62 * f <= chord, `текст шире сектора: n=${n} len=${len} f=${f}`);
    }
  }
});

test('подписи секторов: на 12 секторах короткие числа крупнее длинных надписей', () => {
  assert.ok(labelFontSize(4, 12) > labelFontSize(8, 12));
  assert.equal(labelFontSize(2, 6), 22); // на широком секторе короткая подпись максимального размера
});
