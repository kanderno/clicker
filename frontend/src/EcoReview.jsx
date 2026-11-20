import { useCallback, useEffect, useState } from 'react';
import { getEcoReview, reviewEcoReport } from './api.js';
import Avatar, { displayName } from './Avatar.jsx';
import Coin from './Coin.jsx';
import { ECO_STATUS, MediaGrid } from './Eco.jsx';

const fmt = (n) => Number(n).toLocaleString('ru-RU');
const TABS = [['pending', 'Ждут'], ['approved', 'Одобрены'], ['rejected', 'Отклонены']];
const ERRORS = {
  forbidden: 'Нет доступа к проверке',
  report_not_found: 'Заявка не найдена',
  bad_amount: 'Награда — целое число от 0',
  db_error: 'Ошибка сервера, попробуй ещё раз',
};
const errText = (e) => ERRORS[e.message] || `Ошибка: ${e.message}`;
const inputCls =
  'w-full rounded-lg bg-slate-900 px-2.5 py-2 text-sm text-white outline-none ring-1 ring-slate-700 focus:ring-yellow-400/70';

// Одна заявка на проверке: файлы, описание, награда, комментарий, кнопки решения.
function ReportCard({ r, defaultReward, onDone }) {
  const [reward, setReward] = useState(String(defaultReward));
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const decide = async (approve) => {
    const value = Number(reward);
    if (approve && (!Number.isInteger(value) || value < 0)) return setError(ERRORS.bad_amount);
    if (!approve && !comment.trim()) return setError('Напиши причину отказа — игрок её увидит');
    setBusy(true);
    setError('');
    try {
      const res = await reviewEcoReport(r.id, approve, approve ? value : undefined, comment.trim());
      onDone(res.changed
        ? (approve ? `Одобрено, игроку начислено ${fmt(res.reward)}` : 'Заявка отклонена')
        : 'Эту заявку уже проверили раньше');
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };

  const st = ECO_STATUS[r.status];
  return (
    <div className="rounded-2xl bg-slate-800/70 p-3">
      <div className="flex items-center gap-2">
        {r.user && <Avatar user={r.user} className="h-8 w-8 shrink-0 rounded-full" />}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{r.user ? displayName(r.user) : 'Игрок'}</p>
          <p className="text-xs text-slate-500">{new Date(r.createdAt).toLocaleString('ru-RU')}</p>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${st.cls}`}>{st.text}</span>
      </div>
      <p className="mt-2 break-words text-sm">{r.description}</p>
      <MediaGrid media={r.media} big />

      {r.status === 'pending' ? (
        <div className="mt-3 space-y-2">
          <label className="block text-xs text-slate-400">
            Награда, монет
            <input className={`${inputCls} mt-1`} inputMode="numeric" value={reward}
              onChange={(e) => setReward(e.target.value.replace(/\D/g, '').slice(0, 12))} />
          </label>
          <input className={inputCls} maxLength={300} value={comment} onChange={(e) => setComment(e.target.value)}
            placeholder="Комментарий (при отказе — обязательно)" />
          <div className="grid grid-cols-2 gap-2">
            <button type="button" disabled={busy} onClick={() => decide(true)}
              className="rounded-xl bg-emerald-500 py-2.5 font-semibold text-slate-950 active:bg-emerald-400 disabled:opacity-50">
              ✅ Одобрить
            </button>
            <button type="button" disabled={busy} onClick={() => decide(false)}
              className="rounded-xl bg-red-500/80 py-2.5 font-semibold text-white active:bg-red-500 disabled:opacity-50">
              ✕ Отклонить
            </button>
          </div>
          {error && <p className="text-center text-xs text-red-400">{error}</p>}
        </div>
      ) : (
        <p className="mt-2 text-xs text-slate-400">
          {r.status === 'approved' && (
            <span className="inline-flex items-center gap-1 font-semibold text-emerald-300">
              +<Coin className="h-3.5 w-3.5" />{fmt(r.reward)}
            </span>
          )}
          {' '}{r.reviewer && `проверил ${r.reviewer}`}{r.comment ? ` · «${r.comment}»` : ''}
        </p>
      )}
    </div>
  );
}

export default function EcoReview({ active }) {
  const [status, setStatus] = useState('pending');
  const [data, setData] = useState(null);
  const [msg, setMsg] = useState(null); // { ok, text }

  const load = useCallback(async () => {
    try {
      setData(await getEcoReview(status));
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    }
  }, [status]);

  useEffect(() => {
    if (!active) return undefined;
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [active, load]);

  const done = (text) => {
    setMsg({ ok: true, text });
    load();
  };

  return (
    <div className="h-full overflow-y-auto px-4 py-6 text-white">
      <h1 className="text-center text-xl font-bold">Проверка заявок 🌱</h1>
      <p className="mt-1 text-center text-xs text-slate-400">
        Проверка от <b className="text-yellow-300">{data?.reviewer ?? '…'}</b>
      </p>

      <div className="mt-4 grid grid-cols-3 gap-1 rounded-xl bg-slate-800/70 p-1 text-sm">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" onClick={() => { setStatus(id); setMsg(null); setData(null); }}
            className={`rounded-lg py-2 font-semibold ${status === id ? 'bg-yellow-400 text-slate-950' : 'text-slate-300'}`}>
            {label}{id === 'pending' && data?.pendingCount ? ` (${data.pendingCount})` : ''}
          </button>
        ))}
      </div>

      {msg && <p className={`mt-3 text-center text-sm ${msg.ok ? 'text-emerald-300' : 'text-red-400'}`}>{msg.text}</p>}
      {data && !data.reports.length && (
        <p className="mt-6 text-center text-sm text-slate-500">
          {status === 'pending' ? 'Новых заявок нет 🎉' : 'Здесь пока пусто'}
        </p>
      )}
      <div className="mt-4 space-y-3 pb-2">
        {data?.reports.map((r) => (
          <ReportCard key={r.id} r={r} defaultReward={data.defaultReward} onDone={done} />
        ))}
      </div>
    </div>
  );
}
