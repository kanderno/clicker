import { useCallback, useEffect, useState } from 'react';
import { getLeaderboard } from './api.js';
import Avatar, { displayName, openProfile } from './Avatar.jsx';
import Coin from './Coin.jsx';

const fmt = (n) => Number(n).toLocaleString('ru-RU');
// Короткая запись больших чисел для узких строк: 1,2 млн, 35 тыс.
const short = (n) => {
  const v = Number(n);
  if (v >= 1e9) return `${(v / 1e9).toFixed(1).replace('.0', '')} млрд`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1).replace('.0', '')} млн`;
  if (v >= 1e4) return `${Math.floor(v / 1e3)} тыс`;
  return fmt(v);
};

const GiftIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="8" width="18" height="4" rx="1" />
    <path d="M12 8v13M5 12v9h14v-9M7.5 8a2.5 2.5 0 010-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 010 5" />
  </svg>
);
export const MaskIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M2 9.5C2 7.6 3.6 6.6 5.4 7l4.1 1c1.6.4 3.4.4 5 0l4.1-1c1.8-.4 3.4.6 3.4 2.5 0 4-2.4 7-5.6 7-1.7 0-2.9-1-3.6-2.4-.3-.6-1.3-.6-1.6 0C10.5 15.5 9.3 16.5 7.6 16.5 4.4 16.5 2 13.5 2 9.5Zm5 .3c-1.1 0-2 .6-2 1.2s.9 1.2 2 1.2 2-.6 2-1.2-.9-1.2-2-1.2Zm10 0c-1.1 0-2 .6-2 1.2s.9 1.2 2 1.2 2-.6 2-1.2-.9-1.2-2-1.2Z" />
  </svg>
);

function PlayerRow({ p, canSteal, onGift, onSteal, onNoNick }) {
  return (
    <li className={`lb-row ${p.isMe ? 'is-me' : ''}`}>
      <span className={`lb-place ${p.place <= 3 ? `is-top is-top-${p.place}` : ''}`}>{p.place}</span>
      <button type="button" className="lb-who" onClick={() => openProfile(p.username) || onNoNick(p)}
        aria-label={`Открыть профиль ${displayName(p)}`}>
        <Avatar user={p} className="lb-avatar" />
        <span className="lb-name">
          <b>{displayName(p)}{p.isMe ? ' (ты)' : ''}</b>
          <small><Coin className="lb-coin" />{short(p.balance)}</small>
        </span>
      </button>
      {!p.isMe && (
        <span className="lb-actions">
          <button type="button" className="lb-btn lb-gift" onClick={() => onGift(p)} aria-label={`Подарить ${displayName(p)}`}>
            <GiftIcon />
          </button>
          <button type="button" className={`lb-btn lb-steal ${canSteal ? 'is-armed' : ''}`} onClick={() => onSteal(p)}
            aria-label={canSteal ? `Украсть у ${displayName(p)}` : 'Нет зарядов кражи'}>
            <MaskIcon />
          </button>
        </span>
      )}
    </li>
  );
}

export default function Leaderboard({ active, reloadKey, steals, balance, busy, onGift, onSteal, onBuySteal, onNoNick }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await getLeaderboard());
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [active, load, reloadKey]);

  const charges = steals?.charges ?? 0;
  const canSteal = charges > 0;
  const rowProps = { canSteal, onGift, onSteal, onNoNick };

  return (
    <section className="lb" aria-label="Лидерборды">
      <div className="lb-steals">
        <span className={`lb-steals-icon ${canSteal ? 'is-armed' : ''}`}><MaskIcon /></span>
        <span className="lb-steals-text">
          <b>{canSteal ? `У тебя осталось ${charges} ${plural(charges, ['кража', 'кражи', 'краж'])}` : 'Зарядов кражи нет'}</b>
          <small>{canSteal ? 'Жми маску рядом с игроком — заберёшь часть его монет' : 'Выбей на колесе, получи за стрик или купи'}</small>
        </span>
        {steals && (
          <button type="button" className="lb-buy" disabled={busy || charges >= steals.max || balance < steals.price}
            onClick={onBuySteal}>
            +1 за <Coin className="lb-coin" />{short(steals.price)}
          </button>
        )}
      </div>

      {error && !data && <p className="lb-empty">Не удалось загрузить лидерборд</p>}
      {!data && !error && <p className="lb-empty">Загрузка…</p>}

      {data && (
        <>
          <div className="lb-block">
            <div className="lb-head">
              <span>
                <b>Лига «{data.league?.name ?? '—'}»</b>
                <small>
                  {data.nextLeague
                    ? `До лиги «${data.nextLeague.name}»: ${short(data.coinsToNext)}`
                    : 'Высшая лига'}
                </small>
              </span>
              {data.league && (
                <span className="lb-prize" title="Награды за неделю: 1, 2 и 3 место">
                  🏆 {data.league.rewards.map(short).join(' / ')}
                </span>
              )}
            </div>
            <ol className="lb-list">
              {data.local.map((p) => <PlayerRow key={`l${p.id}`} p={p} {...rowProps} />)}
            </ol>
          </div>

          <div className="lb-block">
            <div className="lb-head">
              <span>
                <b>Глобальный топ</b>
                <small>Все игроки по балансу</small>
              </span>
            </div>
            <ol className="lb-list">
              {data.global.map((p) => <PlayerRow key={`g${p.id}`} p={p} {...rowProps} />)}
            </ol>
          </div>
          <p className="lb-note">
            Лига определяется максимальным балансом за всё время. Каждую неделю топ-3 лиги получают награду.
          </p>
        </>
      )}
    </section>
  );
}

export function plural(n, [one, few, many]) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
