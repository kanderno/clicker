// Математика колеса. Сектор i занимает угол [i*seg, (i+1)*seg), отсчёт по часовой стрелке от верха.
// Указатель всегда сверху. Колесо вращается по часовой стрелке на rot градусов.

export const centerAngle = (i, n) => (i + 0.5) * (360 / n);

const mod360 = (x) => ((x % 360) + 360) % 360;

/** Какой сектор сейчас под указателем при повороте колеса на rot градусов. */
export function sectorAtPointer(rot, n) {
  return Math.floor(mod360(-rot) / (360 / n)) % n;
}

/**
 * Новый общий угол поворота, при котором под указателем окажется сектор i.
 * Угол только растёт (колесо всегда крутится вперёд), минимум `turns` полных оборотов.
 * jitter в [-1, 1] смещает остановку внутри сектора (не дальше 40% от центра к краю), чтобы выглядело живее.
 */
export function nextRotation(current, i, n, turns = 5, jitter = 0) {
  const seg = 360 / n;
  const clamped = Math.max(-1, Math.min(1, jitter));
  const target = mod360(360 - (centerAngle(i, n) + clamped * seg * 0.4));
  const delta = mod360(target - mod360(current));
  return current + turns * 360 + delta;
}

/** Точка на окружности: угол от верха по часовой стрелке. */
export const polar = (cx, cy, r, angle) => {
  const a = (angle * Math.PI) / 180;
  return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
};

/** SVG-путь сектора i из n. */
export function sectorPath(i, n, cx, cy, r) {
  const seg = 360 / n;
  const [x0, y0] = polar(cx, cy, r, i * seg);
  const [x1, y1] = polar(cx, cy, r, (i + 1) * seg);
  const large = seg > 180 ? 1 : 0;
  return `M ${cx} ${cy} L ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`;
}

export const formatCountdown = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};

/** Размер шрифта подписи так, чтобы текст влезал в ширину сектора на радиусе подписи (от 10 до 22). */
export function labelFontSize(len, n, radius = 102) {
  const chord = 2 * radius * Math.sin(Math.PI / n);
  const size = (chord * 0.9) / (0.62 * Math.max(1, len));
  return Math.max(10, Math.min(22, Math.round(size * 10) / 10));
}
