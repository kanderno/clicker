import { useCallback, useEffect, useRef, useState } from 'react';
import WebApp from '@twa-dev/sdk';
import { getWheel, spinWheel } from './api.js';
import Coin from './Coin.jsx';
import { centerAngle, formatCountdown, labelFontSize, nextRotation, sectorPath } from './wheelMath.js';

const SPIN_MS = 4200;
// 10 цветов: при 9 секторах первый и последний (они соседи) не совпадают
const COLORS = ['#f59e0b', '#10b981', '#3b82f6', '#a855f7', '#ef4444', '#14b8a6', '#eab308', '#6366f1', '#f97316', '#ec4899'];
const fmt = (n) => Number(n).toLocaleString('ru-RU');

const ERRORS = {
  free_spin_used: 'Бесплатный спин на сегодня уже использован',
  paid_limit: 'На сегодня платные спины закончились',
  insufficient_funds: 'Не хватает монет',
  db_error: 'Ошибка сервера, попробуй ещё раз',
};

export default function Wheel({ active, balance, onBalance }) {
  const [data, setData] = useState(null);
  const [rotation, setRotation] = useState(0);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const timer = useRef(null);

  const load = useCallback(async () => {
    try {
      const d = await getWheel();
      setData(d);
      setSecondsLeft(d.secondsToReset);
    } catch {
      setError('Не удалось загрузить колесо');
    }
  }, []);

  useEffect(() => {
    if (active) load();
  }, [active, load]);

  // Обратный отсчёт до нового бесплатного спина (только отображение; истина на сервере)
  useEffect(() => {
    if (!data) return undefined;
    const t = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          load();
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [data, load]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const spin = async (mode) => {
    if (busy || !data) return;
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      const r = await spinWheel(mode); // приз уже выбран и начислен сервером
      const idx = data.prizes.findIndex((p) => p.id === r.prize.id);
      const finish = () => {
        setResult(r.prize);
        onBalance(r.balance); // баланс показываем только после остановки колеса, чтобы не спойлерить
        try {
          WebApp.HapticFeedback.notificationOccurred('success');
        } catch {
          /* вне Telegram вибрации нет */
        }
        load();
        setBusy(false);
      };
      if (idx < 0) {
        finish(); // набор призов изменился: просто показываем результат
        return;
      }
      setRotation((cur) => nextRotation(cur, idx, data.prizes.length, 5, Math.random() * 2 - 1));
      timer.current = setTimeout(finish, SPIN_MS + 100);
    } catch (e) {
      setError(ERRORS[e.message] || 'Не получилось, попробуй ещё раз');
      setBusy(false);
      load();
    }
  };

  const prizes = data?.prizes ?? [];
  const n = prizes.length;
  const canPay = data && !data.freeAvailable && data.paidToday < data.paidMax;
  const noMoney = data && balance < data.price;

  return (
    <div className="h-full overflow-y-auto px-4 py-6 text-white">
      <h1 className="text-center text-xl font-bold">Колесо фортуны</h1>
      <p className="mt-2 flex items-center justify-center gap-1.5 text-sm text-slate-400">
        Кошелёк: <Coin className="w-4 h-4" /> <span className="font-semibold text-yellow-400">{fmt(balance)}</span>
      </p>

      <div className="relative mx-auto mt-6 h-72 w-72">
        {/* указатель */}
        <div className="absolute left-1/2 top-[-6px] z-10 -translate-x-1/2"
          style={{ width: 0, height: 0, borderLeft: '14px solid transparent', borderRight: '14px solid transparent', borderTop: '26px solid #f8fafc', filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.5))' }} />
        <svg viewBox="0 0 300 300" className="h-full w-full drop-shadow-[0_0_30px_rgba(251,191,36,0.25)]"
          style={{ transform: `rotate(${rotation}deg)`, transition: `transform ${SPIN_MS}ms cubic-bezier(0.12, 0.6, 0.1, 1)` }}>
          <circle cx="150" cy="150" r="146" fill="#fff8dd" stroke="#d5ad31" strokeWidth="4" />
          {n === 0 && <text x="150" y="155" textAnchor="middle" fill="#64748b" fontSize="14">загрузка…</text>}
          {prizes.map((p, i) => (
            <g key={p.id}>
              <path d={sectorPath(i, n, 150, 150, 140)} fill={COLORS[i % COLORS.length]} stroke="#0f172a" strokeWidth="2" />
              <text
                transform={`rotate(${centerAngle(i, n)} 150 150)`}
                x="150" y="48" textAnchor="middle" fill="#0f172a" fontSize={labelFontSize(p.label.length, n)} fontWeight="800"
                fontFamily="system-ui, sans-serif"
              >
                {p.label}
              </text>
            </g>
          ))}
          <circle cx="150" cy="150" r="22" fill="#fff8dd" stroke="#d5ad31" strokeWidth="4" />
        </svg>
      </div>

      <div className="mt-6 text-center">
        {result && (
          <p className="mb-3 text-lg font-bold text-emerald-300">
            {result.kind === 'free_bet'
              ? `Бесплатная ставка на ${fmt(result.value)}! Используй её во вкладке «Прогнозы».`
              : result.kind === 'steal'
                ? `Ты украл ${fmt(result.value)} монет у случайного игрока!`
                : result.kind === 'part'
                  ? `Деталь: ${result.label}. Собирай майнеры во вкладке «Майнеры».`
                  : `Выигрыш: +${fmt(result.value)} монет`}
          </p>
        )}

        {data?.freeAvailable && (
          <button type="button" disabled={busy} onClick={() => spin('free')}
            className="w-full rounded-2xl bg-yellow-400 py-3.5 text-lg font-bold text-slate-950 active:bg-yellow-300 disabled:opacity-50">
            Крутить бесплатно
          </button>
        )}

        {data && !data.freeAvailable && (
          <>
            <p className="mb-3 text-sm text-slate-400">
              Следующий бесплатный спин через <b className="tabular-nums text-slate-200">{formatCountdown(secondsLeft)}</b>
            </p>
            {canPay ? (
              <button type="button" disabled={busy || noMoney} onClick={() => spin('paid')}
                className="flex w-full items-center justify-center gap-2 rounded-2xl bg-slate-700 py-3.5 text-lg font-bold active:bg-slate-600 disabled:opacity-50">
                Крутить за <Coin className="h-5 w-5" /> {fmt(data.price)}
              </button>
            ) : (
              <p className="rounded-2xl bg-slate-800/70 py-3 text-sm text-slate-400">
                Платные спины на сегодня закончились ({data.paidToday}/{data.paidMax})
              </p>
            )}
            {canPay && noMoney && <p className="mt-2 text-xs text-amber-300">Не хватает монет</p>}
            {canPay && <p className="mt-2 text-xs text-slate-500">Платных сегодня: {data.paidToday}/{data.paidMax}</p>}
          </>
        )}

        <p className="mt-3 h-5 text-sm text-red-400">{error}</p>
      </div>

      <p className="pb-2 text-center text-xs text-slate-500">
        Приз выбирается на сервере. Новый бесплатный спин каждый день в 00:00 UTC.
      </p>
    </div>
  );
}
