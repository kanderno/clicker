import { useCallback, useEffect, useRef, useState } from 'react';
import { getUnseenSteals, login, markStealsSeen } from './api.js';
import Game from './Game.jsx';
import Bank from './Bank.jsx';
import Predictions from './Predictions.jsx';
import Wheel from './Wheel.jsx';
import Miners from './Miners.jsx';
import Admin from './Admin.jsx';

const BASE_TABS = [
  { id: 'game', label: 'Играть', icon: '✦' },
  { id: 'bets', label: 'Прогнозы', icon: '◉' },
  { id: 'wheel', label: 'Колесо', icon: '◎' },
  { id: 'miners', label: 'Майнеры', icon: '↗' },
  { id: 'bank', label: 'Банк', icon: '▣' },
];

function Main({ user }) {
  const [tab, setTab] = useState('game');
  const [balance, setBalance] = useState(user.balance); // баланс всегда приходит с сервера
  const gameRef = useRef(null);
  const [theft, setTheft] = useState(null); // { count, total, upToId }: показываем жертве, что у неё украли
  // Вкладка админа только для админов. Настоящая защита на сервере (403), это лишь интерфейс.
  const tabs = user.isAdmin ? [...BASE_TABS, { id: 'admin', label: 'Админ', icon: '⌘' }] : BASE_TABS;

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

  useEffect(() => {
    checkThefts();
    const t = setInterval(checkThefts, 45000);
    const onVisible = () => document.visibilityState === 'visible' && checkThefts();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [checkThefts]);

  const dismissTheft = async () => {
    const { upToId } = theft;
    setTheft(null);
    try {
      await markStealsSeen(upToId);
    } catch {
      /* если не получилось, покажем снова: лучше повтор, чем потерянное уведомление */
    }
  };

  const go = async (id) => {
    if (id === tab) return;
    // Перед банком отправляем накопленные тапы, чтобы на сервере был актуальный баланс.
    if (id !== 'game') await gameRef.current?.flush();
    setTab(id);
  };

  return (
    <div className="app-shell">
      <main className="app-main flex-1 min-h-0">
        {/* Кликер не размонтируем: его таймер отправки тапов должен работать всегда */}
        <div className={tab === 'game' ? 'h-full' : 'hidden'}>
          <Game ref={gameRef} user={user} balance={balance} onBalance={setBalance} />
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

      <nav className="app-nav" aria-label="Разделы приложения" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => go(t.id)}
            aria-current={tab === t.id ? 'page' : undefined}
            className={`app-nav-item ${tab === t.id ? 'is-active' : ''}`}
          >
            <span className="nav-icon" aria-hidden="true">{t.icon}</span>
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
