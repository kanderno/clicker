import { useCallback, useEffect, useState } from 'react';
import { getGameState, getTransfers, giftSteal, searchUsers, sendTransfer } from './api.js';
import Avatar from './Avatar.jsx';

const fmt = (n) => Number(n).toLocaleString('ru-RU');

const ERRORS = {
  bad_amount: 'Введи целое число больше нуля',
  bad_comment: 'Комментарий: до 100 символов',
  self_transfer: 'Себе переводить нельзя',
  insufficient_funds: 'Недостаточно монет в кошельке',
  daily_limit: 'Лимит переводов на сегодня исчерпан',
  recipient_not_found: 'Игрок не найден',
  no_steal_charges: 'У тебя нет зарядов кражи',
  steal_limit: 'У игрока уже максимум зарядов кражи',
  db_error: 'Ошибка сервера, попробуй ещё раз',
};
const errText = (e) => ERRORS[e.message] || `Ошибка: ${e.message}`;

const inputCls =
  'w-full rounded-xl bg-slate-900 px-3 py-2.5 text-white outline-none ring-1 ring-slate-700 focus:ring-yellow-400/70';

export const userLabel = (u) =>
  u ? [u.first_name, u.username ? `@${u.username}` : null].filter(Boolean).join(' ') || 'Игрок' : 'Игрок';

// preset: { user, nonce } — получатель, выбранный в лидерборде (nonce меняется при каждом нажатии).
export default function Transfer({ active, wallet, onDone, preset }) {
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState(null);
  const [amount, setAmount] = useState('');
  const [comment, setComment] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { ok, text }
  const [history, setHistory] = useState([]);
  const [mode, setMode] = useState('coins'); // 'coins' | 'steal'
  const [charges, setCharges] = useState(null);

  const loadHistory = useCallback(async () => {
    try {
      setHistory((await getTransfers()).transfers);
    } catch {
      /* история не критична */
    }
  }, []);

  const loadCharges = useCallback(async () => {
    try {
      setCharges((await getGameState()).steals.charges);
    } catch {
      /* не критично */
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    loadHistory();
    loadCharges();
  }, [active, loadHistory, loadCharges]);

  useEffect(() => {
    if (!preset?.user) return;
    setSelected(preset.user);
    setQuery('');
    setUsers([]);
    setConfirm(false);
    setMsg(null);
  }, [preset]);

  // Поиск с задержкой: не дёргаем сервер на каждую букву.
  useEffect(() => {
    const term = query.trim().replace(/^@/, '');
    if (!active || term.length < 2) {
      setUsers([]);
      return undefined;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        setUsers((await searchUsers(term)).users);
      } catch (e) {
        setMsg({ ok: false, text: errText(e) });
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [active, query]);

  const value = Number(amount);
  const valid = Number.isInteger(value) && value > 0;

  const pick = (u) => {
    setSelected(u);
    setQuery('');
    setUsers([]);
    setConfirm(false);
    setMsg(null);
  };

  const submitSteal = async () => {
    if (!selected) return;
    if (!confirm) {
      setConfirm(true);
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const r = await giftSteal(selected.id);
      setCharges(r.charges);
      setMsg({ ok: true, text: `Кража подарена → ${userLabel(selected)}` });
      setSelected(null);
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setConfirm(false);
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!selected || !valid) {
      setMsg({ ok: false, text: ERRORS.bad_amount });
      return;
    }
    // Первое нажатие — показать подтверждение, второе — отправить.
    if (!confirm) {
      setConfirm(true);
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const r = await sendTransfer(selected.id, value, comment.trim());
      onDone(r.balance);
      setMsg({ ok: true, text: `Подарено ${fmt(value)} → ${userLabel(selected)}` });
      setAmount('');
      setComment('');
      setSelected(null);
      await loadHistory();
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setConfirm(false);
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto px-4 py-6 text-white">
      <h1 className="text-center text-xl font-bold">Подарки</h1>
      <p className="mt-1 text-center text-sm text-slate-400">
        В кошельке: <b className="tabular-nums text-yellow-400">{wallet != null ? fmt(wallet) : '…'}</b>
        {charges !== null && <> · краж: <b className="tabular-nums text-red-300">{charges}</b></>}
      </p>

      <div className="sub-tabs mt-4" role="tablist">
        {[
          ['coins', 'Монеты'],
          ['steal', 'Кража'],
        ].map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={mode === id}
            onClick={() => { setMode(id); setConfirm(false); setMsg(null); }}
            className={`sub-tab ${mode === id ? 'is-active' : ''}`}>
            {label}
          </button>
        ))}
      </div>

      <div className="mt-4 space-y-3 rounded-2xl bg-slate-800/70 p-4">
        <p className="text-sm font-semibold text-slate-300">
          {mode === 'coins' ? 'Подарить монеты игроку' : 'Подарить заряд кражи игроку'}
        </p>

        {selected ? (
          <div className="flex items-center justify-between rounded-xl bg-yellow-400/15 px-3 py-2.5 ring-1 ring-yellow-400/60">
            <span className="flex min-w-0 items-center gap-2 truncate text-sm">
              <Avatar user={selected} className="h-7 w-7 shrink-0" />
              <span className="truncate">Кому: <b className="text-yellow-300">{userLabel(selected)}</b></span>
            </span>
            <button type="button" onClick={() => { setSelected(null); setConfirm(false); }}
              className="shrink-0 pl-3 text-xs text-slate-400 active:text-white">
              сменить
            </button>
          </div>
        ) : (
          <>
            <input className={inputCls} placeholder="Ник получателя, например @nickname"
              value={query} maxLength={64} onChange={(e) => setQuery(e.target.value)} />
            {query.trim().replace(/^@/, '').length >= 2 && !searching && users.length === 0 && (
              <p className="text-sm text-slate-500">Никого не нашлось</p>
            )}
            <div className="max-h-52 space-y-1.5 overflow-y-auto">
              {users.map((u) => (
                <button key={u.id} type="button" onClick={() => pick(u)}
                  className="flex w-full items-center gap-2 rounded-xl bg-slate-900/70 px-3 py-2 text-left text-sm active:bg-slate-700">
                  <Avatar user={u} className="h-7 w-7 shrink-0" />
                  <span className="truncate">
                    {u.username ? <b className="text-yellow-300">@{u.username}</b> : <span className="text-slate-500">без ника</span>}
                    {u.first_name && <span className="ml-2 text-slate-400">{u.first_name}</span>}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        {selected && mode === 'steal' && (
          <>
            <p className="text-xs text-slate-400">
              Игрок получит 1 заряд и сможет сам украсть у кого-нибудь из лидерборда. У тебя станет на одну кражу меньше.
            </p>
            <button type="button" disabled={busy || !charges} onClick={submitSteal}
              className={`w-full rounded-xl py-3 font-semibold disabled:opacity-50 ${
                confirm ? 'bg-emerald-500 text-slate-950 active:bg-emerald-400' : 'bg-yellow-400 text-slate-950 active:bg-yellow-300'
              }`}>
              {confirm ? `Подтвердить: кража → ${userLabel(selected)}` : 'Подарить 1 кражу'}
            </button>
            {!charges && <p className="text-center text-xs text-amber-300">Зарядов кражи нет: выбей их на колесе или купи на главном экране.</p>}
          </>
        )}

        {selected && mode === 'coins' && (
          <>
            <input type="text" inputMode="numeric" className={inputCls} placeholder="Сколько монет"
              value={amount}
              onChange={(e) => { setAmount(e.target.value.replace(/\D/g, '').slice(0, 12)); setConfirm(false); }} />
            <div className="flex flex-wrap gap-2 text-xs">
              {[100, 1000, 10000].map((v) => (
                <button key={v} type="button" onClick={() => { setAmount(String(v)); setConfirm(false); }}
                  className="rounded-lg bg-slate-700/60 px-3 py-1.5 text-slate-300 active:bg-slate-600">
                  {fmt(v)}
                </button>
              ))}
              {wallet != null && (
                <button type="button" onClick={() => { setAmount(String(wallet)); setConfirm(false); }}
                  className="rounded-lg bg-slate-700/60 px-3 py-1.5 text-slate-300 active:bg-slate-600">
                  весь кошелёк
                </button>
              )}
            </div>
            <input className={inputCls} placeholder="Комментарий (необязательно)"
              value={comment} maxLength={100} onChange={(e) => setComment(e.target.value)} />

            <button type="button" disabled={busy || !valid} onClick={submit}
              className={`w-full rounded-xl py-3 font-semibold disabled:opacity-50 ${
                confirm ? 'bg-emerald-500 text-slate-950 active:bg-emerald-400' : 'bg-yellow-400 text-slate-950 active:bg-yellow-300'
              }`}>
              {confirm
                ? `Подтвердить: ${fmt(value || 0)} → ${userLabel(selected)}`
                : `Подарить ${fmt(value || 0)}`}
            </button>
            {confirm && (
              <p className="text-center text-xs text-amber-300">Подарок нельзя отменить. Проверь ник получателя.</p>
            )}
          </>
        )}

        <p className={`h-5 text-center text-sm ${msg?.ok ? 'text-emerald-300' : 'text-red-400'}`}>{msg?.text}</p>

        {history.length > 0 && (
          <div className="border-t border-slate-700/60 pt-3">
            <p className="text-xs text-slate-400">История подарков</p>
            <div className="mt-2 space-y-1.5">
              {history.map((t) => (
                <div key={t.id} className="rounded-lg bg-slate-900/60 px-3 py-2 text-xs">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate text-slate-300">
                      {t.outgoing ? '→ ' : '← '}{userLabel(t.other)}
                    </span>
                    <span className={`shrink-0 tabular-nums font-semibold ${t.outgoing ? 'text-red-300' : 'text-emerald-300'}`}>
                      {t.outgoing ? '−' : '+'}{fmt(t.amount)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-slate-500">
                    {new Date(t.createdAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}
                    {t.comment ? ` · ${t.comment}` : ''}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <ul className="mt-5 space-y-1.5 text-xs text-slate-400">
        <li>• Найди игрока по нику или нажми 🎁 рядом с ним в лидерборде на главном экране.</li>
        <li>• Дарятся только монеты из кошелька, счёт в банке не трогается.</li>
        <li>• Подарок нельзя отменить.</li>
      </ul>
    </div>
  );
}
