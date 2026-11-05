import { useCallback, useEffect, useState } from 'react';
import { bankDeposit, bankWithdraw, getBankState } from './api.js';
import Coin from './Coin.jsx';

const fmt = (n) => Number(n).toLocaleString('ru-RU');

const ERRORS = {
  insufficient_funds: 'Недостаточно монет',
  bad_amount: 'Введи целое число больше нуля',
  db_error: 'Ошибка сервера, попробуй ещё раз',
};

export default function Bank({ active, onBalance }) {
  const [state, setState] = useState(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { ok: boolean, text: string }

  const load = useCallback(async () => {
    try {
      const s = await getBankState();
      setState(s);
      onBalance(s.wallet);
    } catch (err) {
      setMsg({ ok: false, text: ERRORS[err.message] || `Ошибка: ${err.message}` });
    }
  }, [onBalance]);

  // Обновляем состояние при открытии вкладки и каждые 15 секунд, пока она открыта.
  useEffect(() => {
    if (!active) return undefined;
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [active, load]);

  const run = async (fn, doneText) => {
    const value = Number(amount);
    if (!Number.isInteger(value) || value <= 0) {
      setMsg({ ok: false, text: ERRORS.bad_amount });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const r = await fn(value);
      onBalance(r.wallet);
      setAmount('');
      setMsg({ ok: true, text: doneText(value) });
      await load();
    } catch (err) {
      setMsg({ ok: false, text: ERRORS[err.message] || `Ошибка: ${err.message}` });
    } finally {
      setBusy(false);
    }
  };

  const ratePct = state ? (Number(state.ratePerHour) * 100).toFixed(1) : '…';
  const maxDays = state ? Math.round(state.maxHours / 24) : '…';

  return (
    <div className="h-full overflow-y-auto px-4 py-6 text-white">
      <h1 className="text-center text-xl font-bold">Банк</h1>

      <div className="mt-5 grid grid-cols-2 gap-3">
        <div className="rounded-2xl bg-slate-800/70 p-4">
          <p className="text-xs text-slate-400">Кошелёк</p>
          <p className="mt-1 flex items-center gap-1.5 text-2xl font-bold text-yellow-400 tabular-nums">
            <Coin className="w-6 h-6 shrink-0" />
            {state ? fmt(state.wallet) : '…'}
          </p>
        </div>
        <div className="rounded-2xl bg-emerald-50 p-4 ring-1 ring-emerald-200">
          <p className="text-xs text-emerald-300/80">На счёте</p>
          <p className="mt-1 flex items-center gap-1.5 text-2xl font-bold text-emerald-300 tabular-nums">
            <Coin className="w-6 h-6 shrink-0" />
            {state ? fmt(state.savings) : '…'}
          </p>
          <p className="mt-1 text-xs text-emerald-400/80">
            {state ? `+${fmt(state.hourlyGain)} в час` : ' '}
          </p>
        </div>
      </div>

      <div className="mt-5 rounded-2xl bg-slate-800/70 p-4">
        <input
          type="text"
          inputMode="numeric"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/\D/g, '').slice(0, 12))}
          placeholder="Сумма"
          className="w-full rounded-xl bg-slate-900 px-4 py-3 text-lg text-white outline-none
                     ring-1 ring-slate-700 focus:ring-yellow-400/70"
        />
        <div className="mt-2 flex gap-2 text-xs">
          <button
            type="button"
            onClick={() => state && setAmount(String(state.wallet))}
            className="rounded-lg bg-slate-700/60 px-3 py-1.5 text-slate-300 active:bg-slate-600"
          >
            весь кошелёк
          </button>
          <button
            type="button"
            onClick={() => state && setAmount(String(state.savings))}
            className="rounded-lg bg-slate-700/60 px-3 py-1.5 text-slate-300 active:bg-slate-600"
          >
            весь счёт
          </button>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => run(bankDeposit, (v) => `Положено ${fmt(v)}`)}
            className="rounded-xl bg-yellow-400 py-3 font-semibold text-slate-950 active:bg-yellow-300 disabled:opacity-50"
          >
            Положить
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => run(bankWithdraw, (v) => `Снято ${fmt(v)}`)}
            className="rounded-xl bg-slate-600 py-3 font-semibold active:bg-slate-500 disabled:opacity-50"
          >
            Снять
          </button>
        </div>

        <p className={`mt-3 h-5 text-center text-sm ${msg?.ok ? 'text-emerald-300' : 'text-red-400'}`}>
          {msg?.text}
        </p>
      </div>

      <ul className="mt-5 space-y-1.5 text-xs text-slate-400">
        <li>• Сложные проценты: {ratePct}% в час, начисляются автоматически.</li>
        <li>• Проценты копятся не дольше {maxDays} дней без захода в банк.</li>
        <li>• Монеты на счёте защищены от воровства.</li>
      </ul>
    </div>
  );
}
