import { useCallback, useEffect, useState } from 'react';
import WebApp from '@twa-dev/sdk';
import { getReferrals } from './api.js';
import Avatar, { displayName } from './Avatar.jsx';
import Coin from './Coin.jsx';
import Sheet from './Sheet.jsx';
import { plural } from './Leaderboard.jsx';

const fmt = (n) => Number(n).toLocaleString('ru-RU');

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false; // в старых WebView буфер обмена недоступен
  }
}

// Панель «Пригласи друга» на главном экране и окно со ссылкой и списком приглашённых.
// Монеты начисляет только сервер: здесь лишь ссылка и статистика.
export default function Friends({ active, onToast }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await getReferrals());
    } catch {
      /* панель просто не покажется, остальная игра работает */
    }
  }, []);

  useEffect(() => {
    if (active) load();
  }, [active, load]);

  if (!data) return null;

  const share = () => {
    const text = `Залетай в Pelmen Market! По моей ссылке мне дадут ${fmt(data.bonus)} монет 🥟`;
    const url = `https://t.me/share/url?url=${encodeURIComponent(data.link)}&text=${encodeURIComponent(text)}`;
    try {
      WebApp.openTelegramLink(url);
    } catch {
      window.open(url, '_blank', 'noopener');
    }
  };

  const copy = async () => {
    const done = await copyText(data.link);
    onToast(done, done ? 'Ссылка скопирована' : 'Не получилось скопировать, зажми ссылку и скопируй вручную');
  };

  return (
    <>
      <section className="streak invite" aria-label="Пригласи друга">
        <div className="streak-head">
          <span className="streak-flame invite-icon" aria-hidden="true">🤝</span>
          <span className="streak-title">
            <b>Пригласи друга: +{fmt(data.bonus)}</b>
            <small>
              {data.invited
                ? `Приглашено ${data.invited} ${plural(data.invited, ['друг', 'друга', 'друзей'])}, заработано ${fmt(data.earned)}`
                : 'За каждого нового игрока по твоей ссылке'}
            </small>
          </span>
          <button type="button" className="streak-claim" onClick={() => { setOpen(true); load(); }}>
            Позвать
          </button>
        </div>
      </section>

      {open && (
        <Sheet onClose={() => setOpen(false)}>
          <p className="text-center text-lg font-bold">Пригласи друзей</p>
          <p className="mt-1 text-center text-sm text-slate-400">
            Друг заходит в игру по твоей ссылке впервые — тебе <b className="text-yellow-300">+{fmt(data.bonus)}</b> монет.
            Игроки, которые уже были в игре, не засчитываются.
          </p>

          <div className="invite-stats">
            <span><small>Друзей</small><b>{data.invited}</b></span>
            <span><small>Заработано</small><b><Coin className="invite-coin" />{fmt(data.earned)}</b></span>
          </div>

          {data.link ? (
            <>
              <p className="invite-link" onClick={copy}>{data.link}</p>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <button type="button" onClick={copy} className="rounded-xl bg-slate-700 py-3 font-semibold active:bg-slate-600">
                  Копировать
                </button>
                <button type="button" onClick={share} className="streak-claim rounded-xl py-3" style={{ fontSize: 16 }}>
                  Отправить
                </button>
              </div>
            </>
          ) : (
            <p className="mt-3 text-center text-sm text-red-300">Ссылка временно недоступна, попробуй позже</p>
          )}

          {data.friends.length > 0 && (
            <ul className="invite-friends">
              {data.friends.map((f, i) => (
                <li key={f.user?.id ?? i}>
                  <Avatar user={f.user} className="invite-avatar" />
                  <span className="min-w-0 flex-1 truncate">{displayName(f.user)}</span>
                  <b className="tabular-nums text-emerald-300">+{fmt(f.bonus)}</b>
                </li>
              ))}
            </ul>
          )}

          <button type="button" onClick={() => setOpen(false)}
            className="mt-4 w-full rounded-xl bg-slate-700 py-3 font-semibold active:bg-slate-600">
            Закрыть
          </button>
        </Sheet>
      )}
    </>
  );
}
