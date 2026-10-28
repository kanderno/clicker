import { useCallback, useEffect, useState } from 'react';
import { adminCoinsHistory, adminGrantCoins, adminSearchUsers } from './api.js';

const fmt = (n) => Number(n).toLocaleString('ru-RU');

const ERRORS = {
  bad_amount: 'Сумма: целое число, не ноль',
  bad_reason: 'Комментарий: до 200 символов',
  user_not_found: 'Игрок не найден',
  admin_not_found: 'Твой аккаунт не найден в базе',
  insufficient_funds: 'У игрока не хватает монет на руках, чтобы столько списать',
  forbidden: 'Нет доступа',
  db_error: 'Ошибка сервера, попробуй ещё раз',
};
const errText = (e) => ERRORS[e.message] || `Ошибка: ${e.message}`;

const inputCls =
  'w-full rounded-xl bg-slate-900 px-3 py-2.5 text-white outline-none ring-1 ring-slate-700 focus:ring-yellow-400/70';

const userLabel = (u) =>
  [u.first_name, u.username ? `@${u.username}` : null].filter(Boolean).join(' ') || `ID ${u.telegram_id}`;

export default function AdminCoins({ active }) {
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState(null);
  const [selected, setSelected] = useState(null);
  const [sign, setSign] = useState(1); // 1 = начислить, -1 = списать
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { ok, text }
  const [history, setHistory] = useState([]);

  const search = useCallback(async (q) => {
    try {
      setUsers((await adminSearchUsers(q)).users);
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      setHistory((await adminCoinsHistory()).grants);
    } catch {
      /* история не критична: сам перевод важнее */
    }
  }, []);

  useEffect(() => {
    if (active) loadHistory();
  }, [active, loadHistory]);

  // Поиск с задержкой: не дёргаем сервер на каждую букву.
  useEffect(() => {
    if (!active) return undefined;
    const t = setTimeout(() => search(query.trim()), query ? 350 : 0);
    return () => clearTimeout(t);
  }, [active, query, search]);

  const value = Number(amount);
  const valid = Number.isInteger(value) && value > 0;

  const pick = (u) => {
    setSelected(selected?.id === u.id ? null : u);
    setConfirm(false);
    setMsg(null);
  };

  const submit = async () => {
    if (!selected || !valid) {
      setMsg({ ok: false, text: ERRORS.bad_amount });
      return;
    }
    if (!confirm) {
      setConfirm(true);
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const r = await adminGrantCoins(selected.id, sign * value, reason.trim());
      setMsg({
        ok: true,
        text: `${sign > 0 ? 'Начислено' : 'Списано'} ${fmt(value)} — у ${userLabel(selected)} теперь ${fmt(r.balance)}`,
      });
      setAmount('');
      setReason('');
      setConfirm(false);
      setSelected(null);
      await Promise.all([search(query.trim()), loadHistory()]);
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-6 space-y-3 rounded-2xl bg-slate-800/70 p-4">
      <p className="text-sm font-semibold text-slate-300">Монеты игроку</p>

      <input className={inputCls} placeholder="Поиск: имя, @ник или Telegram ID"
        value={query} maxLength={64} onChange={(e) => setQuery(e.target.value)} />

      {users === null && <p className="text-sm text-slate-500">Загрузка…</p>}
      {users?.length === 0 && <p className="text-sm text-slate-500">Никого не нашлось</p>}

      <div className="max-h-60 space-y-1.5 overflow-y-auto">
        {users?.map((u) => (
          <button key={u.id} type="button" onClick={() => pick(u)}
            className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm ${
              selected?.id === u.id ? 'bg-yellow-400/20 ring-1 ring-yellow-400' : 'bg-slate-900/70 active:bg-slate-700'
            }`}>
            <span className="truncate">
              {userLabel(u)}
              <span className="ml-2 text-xs text-slate-500">ID {u.telegram_id}</span>
            </span>
            <span className="shrink-0 pl-3 tabular-nums text-yellow-400">{fmt(u.balance)}</span>
          </button>
        ))}
      </div>

      {selected && (
        <div className="space-y-3 rounded-xl bg-slate-900/70 p-3">
          <p className="text-sm">
            Выбран: <b className="text-yellow-300">{userLabel(selected)}</b>
            <span className="text-slate-400"> · на руках {fmt(selected.balance)}</span>
          </p>

          <div className="flex gap-2 text-sm">
            {[[1, 'Начислить'], [-1, 'Списать']].map(([v, label]) => (
              <button key={v} type="button" onClick={() => { setSign(v); setConfirm(false); }}
                className={`flex-1 rounded-xl py-2 font-semibold ${
                  sign === v
                    ? v > 0 ? 'bg-emerald-500 text-slate-950' : 'bg-red-500 text-white'
                    : 'bg-slate-800 text-slate-300 active:bg-slate-700'
                }`}>
                {label}
              </button>
            ))}
          </div>

          <input type="text" inputMode="numeric" className={inputCls} placeholder="Сколько монет"
            value={amount}
            onChange={(e) => { setAmount(e.target.value.replace(/\D/g, '').slice(0, 12)); setConfirm(false); }} />
          <div className="flex flex-wrap gap-2 text-xs">
            {[100, 1000, 10000, 100000].map((v) => (
              <button key={v} type="button" onClick={() => { setAmount(String(v)); setConfirm(false); }}
                className="rounded-lg bg-slate-700/60 px-3 py-1.5 text-slate-300 active:bg-slate-600">
                {fmt(v)}
              </button>
            ))}
          </div>

          <input className={inputCls} placeholder="Комментарий (необязательно, виден только админам)"
            value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />

          <button type="button" disabled={busy || !valid} onClick={submit}
            className={`w-full rounded-xl py-3 font-semibold disabled:opacity-50 ${
              confirm
                ? 'bg-yellow-400 text-slate-950 active:bg-yellow-300'
                : sign > 0
                  ? 'bg-emerald-500 text-slate-950 active:bg-emerald-400'
                  : 'bg-red-500 text-white active:bg-red-400'
            }`}>
            {confirm
              ? `Подтвердить: ${sign > 0 ? '+' : '−'}${fmt(value || 0)} игроку ${userLabel(selected)}`
              : `${sign > 0 ? 'Начислить' : 'Списать'} ${fmt(value || 0)}`}
          </button>
          {confirm && (
            <p className="text-center text-xs text-amber-300">Операцию нельзя отменить, она попадёт в журнал.</p>
          )}
        </div>
      )}

      <p className={`h-5 text-center text-sm ${msg?.ok ? 'text-emerald-300' : 'text-red-400'}`}>{msg?.text}</p>

      {history.length > 0 && (
        <div className="border-t border-slate-700/60 pt-3">
          <p className="text-xs text-slate-400">Последние начисления</p>
          <div className="mt-2 space-y-1.5">
            {history.map((g) => (
              <div key={g.id} className="rounded-lg bg-slate-900/60 px-3 py-2 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-slate-300">
                    {g.user ? userLabel(g.user) : '(игрок удалён)'}
                  </span>
                  <span className={`shrink-0 tabular-nums font-semibold ${g.amount > 0 ? 'text-emerald-300' : 'text-red-300'}`}>
                    {g.amount > 0 ? '+' : '−'}{fmt(Math.abs(g.amount))}
                  </span>
                </div>
                <p className="mt-0.5 text-slate-500">
                  {new Date(g.createdAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}
                  {' · от '}{g.admin ? userLabel(g.admin) : '—'}
                  {' · стало '}{fmt(g.balanceAfter)}
                  {g.reason ? ` · ${g.reason}` : ''}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
