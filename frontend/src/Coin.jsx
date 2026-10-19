// Монета в SVG: не зависит от эмодзи-шрифтов системы (🪙 есть не везде, особенно на Windows 10).
const star = Array.from({ length: 10 }, (_, i) => {
  const r = i % 2 === 0 ? 22 : 9;
  const a = (-90 + i * 36) * (Math.PI / 180);
  return `${(50 + r * Math.cos(a)).toFixed(2)},${(50 + r * Math.sin(a)).toFixed(2)}`;
}).join(' ');

export default function Coin({ className = '' }) {
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="coin-face" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fde047" />
          <stop offset="1" stopColor="#f59e0b" />
        </linearGradient>
        <linearGradient id="coin-star" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fffbeb" />
          <stop offset="1" stopColor="#fcd34d" />
        </linearGradient>
      </defs>
      <circle cx="50" cy="50" r="48" fill="url(#coin-face)" stroke="#b45309" strokeWidth="2" />
      <circle cx="50" cy="50" r="38" fill="none" stroke="#b45309" strokeOpacity="0.45" strokeWidth="3" />
      <polygon points={star} fill="url(#coin-star)" stroke="#b45309" strokeOpacity="0.6" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}
