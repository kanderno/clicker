import { useCallback, useEffect, useRef, useState } from 'react';
import WebApp from '@twa-dev/sdk';
import { assetUrl, getWheel, spinWheel } from './api.js';
import Coin from './Coin.jsx';
import { centerAngle, formatCountdown, labelFontSize, nextRotation, polar, sectorPath } from './wheelMath.js';

const SPIN_MS = 4200;
// Бежевые сектора и тёмный обод, как в референсе заказчика. При нечётном числе секторов
// берём три оттенка, чтобы первый и последний (они соседи) не совпали.
const SECTOR_COLORS = (n) => (n % 2 === 0 ? ['#f4e6c8', '#e3c48e'] : ['#f4e6c8', '#e3c48e', '#d2a96a']);
const fmt = (n) => Number(n).toLocaleString('ru-RU');

const ERRORS = {
  free_spin_used: 'Бесплатный спин на сегодня уже использован',
  paid_limit: 'На сегодня платные спины закончились',
  no_bonus_spins: 'Бонусных спинов нет',
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

      <div className="wheel-wrap">
        {/* указатель-булавка сверху */}
        <svg viewBox="0 0 40 52" className="wheel-pin" aria-hidden="true">
          <path d="M20 50 6 22a15 15 0 1128 0Z" fill="#fff" stroke="#2b2622" strokeWidth="3" />
          <circle cx="20" cy="17" r="5" fill="#2b2622" />
        </svg>
        <svg viewBox="0 0 300 300" className="wheel-disc"
          style={{ transform: `rotate(${rotation}deg)`, transition: `transform ${SPIN_MS}ms cubic-bezier(0.12, 0.6, 0.1, 1)` }}>
          <circle cx="150" cy="150" r="148" fill="#2b2622" />
          {n === 0 && <text x="150" y="155" textAnchor="middle" fill="#cbb995" fontSize="14">загрузка…</text>}
          {prizes.map((p, i) => {
            const colors = SECTOR_COLORS(n);
            const fontSize = labelFontSize(p.label.length, n) * (p.image_url ? 0.75 : 1);
            return (
              <g key={p.id}>
                <path d={sectorPath(i, n, 150, 150, 136)} fill={colors[i % colors.length]} stroke="#8a6a3a" strokeWidth="1.2" />
                <g transform={`rotate(${centerAngle(i, n)} 150 150)`}>
                  {p.image_url && (
                    <image href={assetUrl(p.image_url)} x="132" y="30" width="36" height="36" preserveAspectRatio="xMidYMid meet" />
                  )}
                  <text x="150" y={p.image_url ? 80 : 50} textAnchor="middle" fill="#3b2a12" fontSize={fontSize}
                    fontWeight="800" fontFamily="Manrope, system-ui, sans-serif">
                    {p.label}
                  </text>
                </g>
              </g>
            );
          })}
          {/* болты на ободе между секторами */}
          {prizes.map((p, i) => {
            const [x, y] = polar(150, 150, 142, (360 / n) * i);
            return <circle key={`b${p.id}`} cx={x} cy={y} r="3.2" fill="#d8b878" />;
          })}
          <circle cx="150" cy="150" r="24" fill="#2b2622" stroke="#d8b878" strokeWidth="4" />
          <circle cx="150" cy="150" r="8" fill="#d8b878" />
        </svg>
        <span className="wheel-stand" aria-hidden="true" />
      </div>

      <div className="mt-6 text-center">
        {result && (
          <p className="mb-3 text-lg font-bold text-emerald-300">
            {result.kind === 'free_bet'
              ? `Бесплатная ставка на ${fmt(result.value)}! Используй её во вкладке «Прогнозы».`
              : result.kind === 'steal'
                ? 'Заряд кражи! Укради у любого игрока в лидерборде на главном экране.'
                : result.kind === 'part'
                  ? `Деталь: ${result.label}. Собирай майнеры во вкладке «Майнеры».`
                  : `Выигрыш: +${fmt(result.value)} монет`}
          </p>
        )}

        {data?.bonusSpins > 0 && (
          <button type="button" disabled={busy} onClick={() => spin('bonus')}
            className="mb-3 w-full rounded-2xl bg-emerald-500 py-3.5 text-lg font-bold text-slate-950 active:bg-emerald-400 disabled:opacity-50">
            Бонусный спин ({data.bonusSpins})
          </button>
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
                {data.vipUntil && data.basePrice > data.price && (
                  <s className="text-sm font-semibold text-slate-400">{fmt(data.basePrice)}</s>
                )}
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

      <div className="wheel-legend">
        <p><b>Число</b> — столько монет сразу падает в кошелёк.</p>
        <p><b>Фрибет 100</b> — бесплатная ставка на 100 монет во вкладке «Прогнозы»: монеты не списываются, а выигрыш твой.</p>
        <p><b>Кража</b> — заряд кражи: выбери игрока в лидерборде и забери часть его монет.</p>
        <p><b>Бонусные спины</b> дают за стрик на главном экране.</p>
      </div>

      <p className="pb-2 text-center text-xs text-slate-500">
        Приз выбирается на сервере. Новый бесплатный спин каждый день в 00:00 UTC.
      </p>
    </div>
  );
}
