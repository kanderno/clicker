import { plural } from './Leaderboard.jsx';

const fmt = (n) => Number(n).toLocaleString('ru-RU');

// Подпись награды дня: монеты, бонусные спины, заряды кражи.
export function rewardParts(r = {}) {
  const parts = [];
  if (r.coins > 0) parts.push(`+${fmt(r.coins)}`);
  if (r.spins > 0) parts.push(r.spins > 1 ? `${r.spins} спина` : 'спин');
  if (r.steals > 0) parts.push(r.steals > 1 ? `${r.steals} кражи` : 'кража');
  if (r.boost > 0) parts.push(`буст ${r.boost >= 60 && r.boost % 60 === 0 ? `${r.boost / 60}ч` : `${r.boost}м`}`);
  if (r.vip > 0) parts.push(`VIP ${r.vip}ч`);
  return parts;
}

// Панель стрика: 7 дней цикла, награда за каждый день подряд.
export default function Streak({ streak, busy, onClaim }) {
  if (!streak) return null;
  const len = Math.max(streak.rewards.length, 1);
  // Сколько дней текущего цикла уже забрано
  const done = streak.claimedToday ? ((streak.days - 1) % len) + 1 : streak.days % len;

  return (
    <section className="streak" aria-label="Ежедневный стрик">
      <div className="streak-head">
        <span className="streak-flame" aria-hidden="true">🔥</span>
        <span className="streak-title">
          <b>Стрик: {streak.days} {plural(streak.days, ['день', 'дня', 'дней'])}</b>
          <small>{streak.claimedToday ? 'Награда за сегодня получена, приходи завтра' : 'Заходи каждый день — награды растут'}</small>
        </span>
        <button type="button" className="streak-claim" disabled={busy || streak.claimedToday} onClick={onClaim}>
          {streak.claimedToday ? 'Взято' : 'Забрать'}
        </button>
      </div>
      <ol className="streak-days">
        {streak.rewards.map((r, i) => {
          const state = i < done ? 'is-done' : i === done && !streak.claimedToday ? 'is-today' : '';
          return (
            <li key={i} className={`streak-day ${state}`}>
              <span className="streak-day-num">{i + 1}</span>
              {rewardParts(r).map((t) => <span key={t} className="streak-day-reward">{t}</span>)}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
