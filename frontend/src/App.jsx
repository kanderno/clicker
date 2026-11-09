import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getUnseenNotices, getUnseenSteals, getUnseenTransfers, login, markNoticesSeen, markStealsSeen, markTransfersSeen,
} from './api.js';
import NoticesModal from './Notices.jsx';
import Game from './Game.jsx';
import Bank from './Bank.jsx';
import Transfer, { userLabel } from './Transfer.jsx';
import Predictions from './Predictions.jsx';
import Wheel from './Wheel.jsx';
import Miners from './Miners.jsx';
import Admin from './Admin.jsx';

const BASE_TABS = [
  { id: 'game', label: 'Играть', icon: 'game' },
  { id: 'gift', label: 'Подарить', icon: 'gift' },
  { id: 'bets', label: 'Прогнозы', icon: 'bets' },
  { id: 'wheel', label: 'Колесо', icon: 'wheel' },
  { id: 'miners', label: 'Майнеры', icon: 'miners' },
  { id: 'bank', label: 'Банк', icon: 'bank' },
];

const ICONS = {
  game: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 6.9v10.2M9.7 9.7h3.5a1.75 1.75 0 010 3.5H9.7" />
    </>
  ),
  bets: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  wheel: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v6M12 15v6M3 12h6M15 12h6" />
    </>
  ),
  miners: (
    <>
      <path d="M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2c.9-.9.9-2.3 0-3.2-.9-.9-2.3-.8-3 .2Z" />
      <path d="M9 14.5 6.5 12c.8-4.2 3.5-8 9.5-9 1 6-.8 9.7-5 11.5Z" />
      <circle cx="14.5" cy="8.5" r="1.6" />
    </>
  ),
  gift: (
    <>
      <rect x="3" y="8" width="18" height="4" rx="1" />
      <path d="M12 8v13M5 12v9h14v-9M7.5 8a2.5 2.5 0 010-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 010 5" />
    </>
  ),
  bank: <path d="M3 9.5 12 4l9 5.5M4 9.5V20M20 9.5V20M2 20h20M8 20v-7M16 20v-7M12 20v-7" />,
  admin: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1Z" />
    </>
  ),
};

function TabIcon({ id }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[id]}
    </svg>
  );
}

function Main({ user }) {
  const [tab, setTab] = useState('game');
  const [balance, setBalance] = useState(user.balance); // баланс всегда приходит с сервера
  const gameRef = useRef(null);
  const [theft, setTheft] = useState(null); // { count, total, upToId }: показываем жертве, что у неё украли
  const [gift, setGift] = useState(null); // { list, upToId }: входящие переводы от других игроков
  const [notices, setNotices] = useState(null); // { list, upToId }: результаты ставок и другие новости
  const [giftPreset, setGiftPreset] = useState(null); // { user, nonce }: получатель из лидерборда
  // Вкладка админа только для админов. Настоящая защита на сервере (403), это лишь интерфейс.
  const tabs = user.isAdmin ? [...BASE_TABS, { id: 'admin', label: 'Админ', icon: 'admin' }] : BASE_TABS;

  const checkThefts = useCallback(async () => {
    try {
      const r = await getUnseenSteals();
      if (r.steals.length) {
        setBalance(r.balance); // монеты уже списаны на сервере: обновляем баланс
        setTheft({
          count: r.steals.length,
          total: r.steals.reduce((sum, x) => sum + Number(x.amount), 0),
          upToId: Math.max(...r.steals.map((x) => x.id)),
        });
      }
    } catch {
      /* уведомление не критично: попробуем в следующий раз */
    }
  }, []);

  const checkTransfers = useCallback(async () => {
    try {
      const r = await getUnseenTransfers();
      if (r.transfers.length) {
        setBalance(r.balance); // монеты уже зачислены на сервере
        setGift({ list: r.transfers, upToId: Math.max(...r.transfers.map((x) => x.id)) });
      }
    } catch {
      /* уведомление не критично: попробуем в следующий раз */
    }
  }, []);

  const checkNotices = useCallback(async () => {
    try {
      const r = await getUnseenNotices();
      if (r.notices.length) {
        setBalance(r.balance); // выплаты уже прошли на сервере
        setNotices({ list: r.notices, upToId: Math.max(...r.notices.map((x) => x.id)) });
      }
    } catch {
      /* уведомление не критично: попробуем в следующий раз */
    }
  }, []);

  useEffect(() => {
    const check = () => {
      checkThefts();
      checkTransfers();
      checkNotices();
    };
    check();
    const t = setInterval(check, 45000);
    const onVisible = () => document.visibilityState === 'visible' && check();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [checkThefts, checkTransfers, checkNotices]);

  const dismissTheft = async () => {
    const { upToId } = theft;
    setTheft(null);
    try {
      await markStealsSeen(upToId);
    } catch {
      /* если не получилось, покажем снова: лучше повтор, чем потерянное уведомление */
    }
  };

  const dismissGift = async () => {
    const { upToId } = gift;
    setGift(null);
    try {
      await markTransfersSeen(upToId);
    } catch {
      /* если не получилось, покажем снова */
    }
  };

  const dismissNotices = async () => {
    const { upToId } = notices;
    setNotices(null);
    try {
      await markNoticesSeen(upToId);
    } catch {
      /* если не получилось, покажем снова */
    }
  };

  const go = async (id) => {
    if (id === tab) return;
    // Перед банком отправляем накопленные тапы, чтобы на сервере был актуальный баланс.
    if (id !== 'game') await gameRef.current?.flush();
    setTab(id);
  };

  // Кнопка 🎁 в лидерборде: открываем вкладку подарков с уже выбранным получателем.
  const giftTo = async (p) => {
    setGiftPreset({
      user: { id: p.id, username: p.username, first_name: p.firstName, photo_url: p.photoUrl },
      nonce: Date.now(),
    });
    await go('gift');
  };

  return (
    <div className="app-shell">
      <main className="app-main flex-1 min-h-0">
        {/* Кликер не размонтируем: его таймер отправки тапов должен работать всегда */}
        <div className={tab === 'game' ? 'h-full' : 'hidden'}>
          <Game ref={gameRef} user={user} active={tab === 'game'} balance={balance} onBalance={setBalance} onGift={giftTo} />
        </div>
        <div className={tab === 'bets' ? 'h-full' : 'hidden'}>
          <Predictions active={tab === 'bets'} balance={balance} onBalance={setBalance} />
        </div>
        <div className={tab === 'wheel' ? 'h-full' : 'hidden'}>
          <Wheel active={tab === 'wheel'} balance={balance} onBalance={setBalance} />
        </div>
        <div className={tab === 'miners' ? 'h-full' : 'hidden'}>
          <Miners active={tab === 'miners'} onBalance={setBalance} />
        </div>
        <div className={tab === 'bank' ? 'h-full' : 'hidden'}>
          <Bank active={tab === 'bank'} onBalance={setBalance} />
        </div>
        <div className={tab === 'gift' ? 'h-full' : 'hidden'}>
          <Transfer active={tab === 'gift'} wallet={balance} onDone={setBalance} preset={giftPreset} />
        </div>
        {user.isAdmin && (
          <div className={tab === 'admin' ? 'h-full' : 'hidden'}>
            <Admin active={tab === 'admin'} />
          </div>
        )}
      </main>

      {theft && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 px-6 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl bg-slate-800 p-6 text-center text-white shadow-2xl ring-1 ring-red-500/40">
            <p className="text-xl font-bold text-red-400">Тебя обокрали!</p>
            <p className="mt-3 text-slate-200">
              {theft.count === 1
                ? `Случайный игрок украл у тебя ${theft.total.toLocaleString('ru-RU')} монет.`
                : `Тебя обокрали ${theft.count} раз(а) на общую сумму ${theft.total.toLocaleString('ru-RU')} монет.`}
            </p>
            <p className="mt-2 text-sm text-slate-400">Монеты на сберегательном счёте в безопасности.</p>
            <button type="button" onClick={dismissTheft}
              className="mt-5 w-full rounded-xl bg-yellow-400 py-3 font-semibold text-slate-950 active:bg-yellow-300">
              Понятно
            </button>
          </div>
        </div>
      )}

      {gift && !theft && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 px-6 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl bg-slate-800 p-6 text-center text-white shadow-2xl ring-1 ring-emerald-500/40">
            <p className="text-xl font-bold text-emerald-400">Тебе подарили монеты!</p>
            <div className="mt-3 max-h-60 space-y-2 overflow-y-auto">
              {gift.list.map((t) => (
                <div key={t.id} className="rounded-xl bg-slate-900/70 px-3 py-2 text-sm">
                  <p>
                    <b className="text-yellow-300">{userLabel(t.from)}</b>
                    <span className="text-slate-300"> → </span>
                    <b className="tabular-nums text-emerald-300">+{t.amount.toLocaleString('ru-RU')}</b>
                  </p>
                  {t.comment && <p className="mt-0.5 break-words text-xs text-slate-400">«{t.comment}»</p>}
                </div>
              ))}
            </div>
            <button type="button" onClick={dismissGift}
              className="mt-5 w-full rounded-xl bg-yellow-400 py-3 font-semibold text-slate-950 active:bg-yellow-300">
              Отлично
            </button>
          </div>
        </div>
      )}

      {notices && !theft && !gift && <NoticesModal list={notices.list} onClose={dismissNotices} />}

      <nav
        className={`app-nav ${tabs.length > 5 ? 'is-dense' : ''}`}
        aria-label="Разделы приложения"
        style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => go(t.id)}
            aria-current={tab === t.id ? 'page' : undefined}
            className={`app-nav-item ${tab === t.id ? 'is-active' : ''}`}
          >
            <span className="nav-icon"><TabIcon id={t.icon} /></span>
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

export default function App() {
  const [state, setState] = useState({ status: 'loading' });

  useEffect(() => {
    login()
      .then((user) => setState({ status: 'ok', user }))
      .catch((err) => setState({ status: 'error', message: err.message }));
  }, []);

  if (state.status === 'ok') return <Main user={state.user} />;

  let content;
  if (state.status === 'loading') {
    content = <p className="text-slate-300">Загрузка…</p>;
  } else if (state.message === 'not_in_telegram') {
    content = <p className="text-amber-300">Открой приложение внутри Telegram 📱</p>;
  } else {
    content = <p className="text-red-400">Ошибка входа: {state.message}</p>;
  }

  return (
    <div className="app-loading h-full flex items-center justify-center bg-slate-900 text-white p-6">
      <div className="text-center">{content}</div>
    </div>
  );
}
