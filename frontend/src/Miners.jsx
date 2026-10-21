import { useCallback, useEffect, useState } from 'react';
import { buildMiner, buyPart, collectMiners, getMiners, upgradeMiner } from './api.js';
import Coin from './Coin.jsx';

const fmt = (n) => Number(n).toLocaleString('ru-RU');

const ERRORS = {
  not_enough_parts: 'Не хватает деталей',
  max_level: 'Майнер уже на максимальном уровне',
  insufficient_funds: 'Не хватает монет',
  miner_limit: 'Достигнут лимит майнеров',
  bad_type: 'Этот майнер сейчас недоступен',
  miner_not_found: 'Майнер не найден',
  bad_part: 'Такой детали нет',
  bad_qty: 'Неверное количество',
  db_error: 'Ошибка сервера, попробуй ещё раз',
};

export default function Miners({ active, onBalance }) {
  const [view, setView] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { ok, text }

  const load = useCallback(async () => {
    try {
      const v = await getMiners();
      setView(v);
      onBalance(v.balance);
    } catch {
      setMsg({ ok: false, text: 'Не удалось загрузить майнеры' });
    }
  }, [onBalance]);

  // Обновляем при открытии и каждые 20 секунд: накопленный доход растёт со временем.
  useEffect(() => {
    if (!active) return undefined;
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [active, load]);

  const act = async (fn, okText) => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await fn();
      if (r.balance !== undefined) onBalance(r.balance);
      setMsg({ ok: true, text: okText(r) });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: ERRORS[e.message] || 'Не получилось, попробуй ещё раз' });
      load();
    } finally {
      setBusy(false);
    }
  };

  if (!view) {
    return (
      <div className="flex h-full items-center justify-center text-slate-500">
        {msg ? <span className="text-red-400">{msg.text}</span> : 'Загрузка…'}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-4 py-6 text-white">
      <h1 className="text-center text-xl font-bold">Майнеры</h1>
      <p className="mt-2 flex items-center justify-center gap-1.5 text-sm text-slate-400">
        Кошелёк: <Coin className="w-4 h-4" /> <span className="font-semibold text-yellow-400">{fmt(view.balance)}</span>
      </p>

      {/* Сбор дохода */}
      <button
        type="button"
        disabled={busy || view.pendingTotal === 0}
        onClick={() => act(collectMiners, (r) => `Собрано +${fmt(r.collected)}`)}
        className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-yellow-400 py-3.5 text-lg font-bold text-slate-950 active:bg-yellow-300 disabled:opacity-40"
      >
        Собрать доход <Coin className="h-5 w-5" /> +{fmt(view.pendingTotal)}
      </button>
      <p className="mt-2 text-center text-xs text-slate-500">
        Доход копится не дольше {view.capHours} ч, заходи собирать вовремя.
      </p>
      <p className={`mt-1 h-5 text-center text-sm ${msg?.ok ? 'text-emerald-300' : 'text-red-400'}`}>{msg?.text}</p>

      {/* Мои майнеры */}
      <p className="mt-3 text-sm font-semibold text-slate-300">
        Мои майнеры ({view.miners.length}/{view.maxMiners})
      </p>
      {view.miners.length === 0 && (
        <p className="mt-2 rounded-xl bg-slate-800/60 p-4 text-center text-sm text-slate-500">
          Пока нет ни одного майнера. Собери первый из деталей ниже.
        </p>
      )}
      <div className="mt-2 space-y-3">
        {view.miners.map((m) => {
          const pct = m.pendingMax > 0 ? Math.min(100, (m.pending / m.pendingMax) * 100) : 0;
          return (
            <div key={m.id} className="rounded-2xl bg-slate-800/70 p-4">
              <div className="flex items-start justify-between">
                <p className="font-semibold">
                  {m.name} <span className="text-xs font-normal text-slate-400">ур. {m.level}/{m.maxLevel}</span>
                </p>
                <p className="text-sm text-emerald-300">+{fmt(m.incomePerHour)}/ч</p>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-900">
                <div className="h-full rounded-full bg-emerald-400 transition-all" style={{ width: `${pct}%` }} />
              </div>
              <p className="mt-1 text-xs text-slate-400">
                накоплено {fmt(m.pending)} из {fmt(m.pendingMax)}
              </p>
              {m.upgradeCost === null ? (
                <p className="mt-3 text-xs text-amber-300">Максимальный уровень</p>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => act(() => upgradeMiner(m.id), (r) => `Улучшено до ${r.level} уровня`)}
                  className="mt-3 flex items-center gap-1.5 rounded-lg bg-slate-700 px-3 py-2 text-sm font-semibold active:bg-slate-600 disabled:opacity-50"
                >
                  Улучшить за <Coin className="h-4 w-4" /> {fmt(m.upgradeCost)}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Детали */}
      <p className="mt-6 text-sm font-semibold text-slate-300">Детали</p>
      <div className="mt-2 grid grid-cols-3 gap-2">
        {view.parts.map((p) => (
          <div key={p.id} className="rounded-xl bg-slate-800/70 p-3 text-center">
            <p className="text-xs text-slate-400">{p.name}</p>
            <p className="mt-1 text-2xl font-bold tabular-nums">{fmt(p.qty)}</p>
            <button
              type="button"
              disabled={busy || view.balance < p.shopPrice}
              onClick={() => act(() => buyPart(p.id, 1), () => `Куплено: ${p.name}`)}
              className="mt-2 flex w-full items-center justify-center gap-1 rounded-lg bg-slate-700 py-1.5 text-xs font-semibold active:bg-slate-600 disabled:opacity-40"
            >
              <Coin className="h-3.5 w-3.5" /> {fmt(p.shopPrice)}
            </button>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-slate-500">Детали также выпадают на колесе фортуны.</p>

      {/* Сборка */}
      <p className="mt-6 text-sm font-semibold text-slate-300">Собрать майнер</p>
      <div className="mt-2 space-y-3 pb-4">
        {view.types.map((t) => (
          <div key={t.id} className="rounded-2xl bg-slate-800/70 p-4">
            <div className="flex items-start justify-between">
              <p className="font-semibold">{t.name}</p>
              <p className="text-sm text-emerald-300">+{fmt(t.baseIncome)}/ч</p>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {t.recipe.map((r) => (
                <span
                  key={r.partId}
                  className={`rounded-md px-2 py-1 text-xs ${
                    r.have >= r.qty ? 'bg-emerald-500/20 text-emerald-300' : 'bg-red-500/15 text-red-300'
                  }`}
                >
                  {r.partName} {r.have}/{r.qty}
                </span>
              ))}
            </div>
            <button
              type="button"
              disabled={busy || !t.canBuild}
              onClick={() => act(() => buildMiner(t.id), () => `Собран: ${t.name}`)}
              className="mt-3 w-full rounded-xl bg-yellow-400 py-2.5 font-semibold text-slate-950 active:bg-yellow-300 disabled:opacity-40"
            >
              Собрать
            </button>
          </div>
        ))}
        {!view.canBuildMore && <p className="text-xs text-amber-300">Достигнут лимит майнеров ({view.maxMiners}).</p>}
      </div>
    </div>
  );
}
