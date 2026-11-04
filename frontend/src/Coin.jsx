// Пелькоин: золотая монета с тиснёным пельменем.
// Размеры считаем один раз при загрузке модуля, чтобы не дёргать DOM.
const N = 16;
const R = 50;
const CX = 100;
const CY = 100;

const scallopPath = (() => {
  const pts = Array.from({ length: N + 1 }, (_, i) => {
    const a = (i * 2 * Math.PI) / N;
    return [CX + R * Math.cos(a), CY + R * Math.sin(a)];
  });
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (const [x, y] of pts.slice(1)) {
    const b = (R * 0.235).toFixed(1);
    d += `A${b} ${b} 0 0 1 ${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return `${d}Z`;
})();

const crimpTicks = Array.from({ length: N }, (_, i) => {
  const a = ((i + 0.5) * 2 * Math.PI) / N;
  const r1 = R * 0.74;
  const r2 = R - 2;
  const p = (rad) => `${(CX + rad * Math.cos(a)).toFixed(1)} ${(CY + rad * Math.sin(a)).toFixed(1)}`;
  return `M${p(r1)}L${p(r2)}`;
}).join('');

export default function Coin({ className = '' }) {
  return (
    <svg viewBox="0 0 200 200" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="pm-rim" x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0" stopColor="#ffe9a8" />
          <stop offset="0.45" stopColor="#ffcb3d" />
          <stop offset="1" stopColor="#d98a00" />
        </linearGradient>
        <linearGradient id="pm-face" x1="0.25" y1="0" x2="0.8" y2="1">
          <stop offset="0" stopColor="#fff4c9" />
          <stop offset="0.4" stopColor="#ffd257" />
          <stop offset="1" stopColor="#eda007" />
        </linearGradient>
        <radialGradient id="pm-emboss" cx="0.42" cy="0.3" r="0.78">
          <stop offset="0" stopColor="#c8820f" />
          <stop offset="0.62" stopColor="#ad6500" />
          <stop offset="1" stopColor="#8d4c00" />
        </radialGradient>
        <radialGradient id="pm-gloss" cx="0.32" cy="0.14" r="0.85">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.5" />
          <stop offset="0.55" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
      </defs>

      <circle cx="100" cy="100" r="97" fill="#5a3a00" />
      <circle cx="100" cy="100" r="93" fill="url(#pm-rim)" />
      <circle cx="100" cy="100" r="84" fill="url(#pm-face)" />
      <circle cx="100" cy="100" r="78" fill="none" stroke="#c98a12" strokeOpacity="0.45" strokeWidth="2.5" />

      {/* тиснёный пельмень */}
      <path d={scallopPath} fill="url(#pm-emboss)" />
      <path d={crimpTicks} fill="none" stroke="#84460a" strokeOpacity="0.5" strokeWidth="3" strokeLinecap="round" />
      <path d={scallopPath} fill="none" stroke="#7c4200" strokeOpacity="0.5" strokeWidth="2.5" />
      <path d="M66 88c10-15 29-23 48-20" fill="none" stroke="#ffd98a" strokeWidth="5" strokeLinecap="round" strokeOpacity="0.5" />
      <circle cx="100" cy="100" r="84" fill="url(#pm-gloss)" />
      <path d="M25 84A84 84 0 0 1 132 24" fill="none" stroke="#fff8d8" strokeWidth="6" strokeLinecap="round" strokeOpacity="0.4" />
    </svg>
  );
}
