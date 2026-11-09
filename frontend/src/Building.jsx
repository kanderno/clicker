// Рисунки зданий по умолчанию (если админ не загрузил свою картинку).
// Все рисунки в одной сетке 120×100: стена, витрина, полосатый навес, вывеска.
const PALETTES = {
  stall: { wall: '#d9a35f', roof: '#c0392b', stripe: '#fff4e0', sign: '#8e2b20' },
  shop: { wall: '#e9dcc3', roof: '#2e86c1', stripe: '#f4f9ff', sign: '#1d5f8c' },
  canteen: { wall: '#f1e3c8', roof: '#27a065', stripe: '#f2fff7', sign: '#1c6e47' },
  restaurant: { wall: '#c9a27a', roof: '#8e2a3a', stripe: '#f7e3c9', sign: '#5c1a26' },
};
const FALLBACK = { wall: '#ddc9a8', roof: '#d4881c', stripe: '#fff3dd', sign: '#8a5a10' };

export default function Building({ code, label, className = '' }) {
  const p = PALETTES[code] ?? FALLBACK;
  const big = code === 'restaurant' || code === 'canteen';
  const stripes = Array.from({ length: 6 }, (_, i) => i);
  return (
    <svg viewBox="0 0 120 100" className={className} aria-hidden="true">
      <ellipse cx="60" cy="94" rx="52" ry="5" fill="#000" opacity=".22" />
      {/* стена */}
      <rect x={big ? 12 : 22} y={big ? 30 : 40} width={big ? 96 : 76} height={big ? 60 : 50} rx="3" fill={p.wall} />
      {big && <rect x="12" y="26" width="96" height="8" rx="2" fill={p.sign} />}
      {/* вывеска */}
      <rect x="38" y={big ? 14 : 26} width="44" height="13" rx="3" fill={p.sign} />
      <text x="60" y={big ? 23.5 : 35.5} textAnchor="middle" fontSize="7.5" fontWeight="800" fill="#fff"
        fontFamily="Manrope, system-ui, sans-serif">{label}</text>
      {/* навес в полоску */}
      <path d={big ? 'M8 40h104l-6 14H14Z' : 'M18 46h84l-6 13H24Z'} fill={p.roof} />
      {stripes.map((i) => {
        const x0 = big ? 8 + i * 17.3 : 18 + i * 14;
        const w = big ? 8.6 : 7;
        return <path key={i} d={big
          ? `M${x0 + 4} 40h${w}l-1 14h-${w}Z`
          : `M${x0 + 3} 46h${w}l-1 13h-${w}Z`} fill={p.stripe} opacity=".9" />;
      })}
      {/* витрина и дверь */}
      <rect x={big ? 20 : 28} y={big ? 60 : 63} width={big ? 34 : 26} height={big ? 22 : 18} rx="2" fill="#7fc4e8" />
      <rect x={big ? 20 : 28} y={big ? 60 : 63} width={big ? 34 : 26} height="4" fill="#fff" opacity=".35" />
      <rect x={big ? 66 : 62} y={big ? 58 : 62} width={big ? 18 : 14} height={big ? 32 : 28} rx="2" fill={p.sign} />
      {big && <rect x="90" y="60" width="12" height="22" rx="2" fill="#7fc4e8" />}
      {code === 'restaurant' && (
        <>
          <rect x="15" y="56" width="3" height="34" fill="#efe2cc" />
          <rect x="102" y="56" width="3" height="34" fill="#efe2cc" />
        </>
      )}
      {code === 'stall' && <circle cx="96" cy="78" r="7" fill="#e8b04a" stroke="#8a5a10" strokeWidth="2" />}
    </svg>
  );
}
