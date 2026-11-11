import { useCallback, useEffect, useState } from 'react';
import { assetUrl, collectLocations, getLocations, upgradeLocation } from './api.js';
import Coin from './Coin.jsx';
import Building from './Building.jsx';
import Sheet from './Sheet.jsx';

const fmt = (n) => Number(n).toLocaleString('ru-RU');
// Короткая запись как в макете: 156.92K, 10M
const short = (n) => {
  const v = Number(n);
  if (v >= 1e9) return `${+(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${+(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${+(v / 1e3).toFixed(2)}K`;
  return String(v);
};

const ERRORS = {
  max_level: 'Локация уже на максимальном уровне',
  insufficient_funds: 'Не хватает монет',
  location_not_found: 'Эта локация сейчас недоступна',
  db_error: 'Ошибка сервера, попробуй ещё раз',
};

// Места зданий на карте (в процентах), по порядку локаций.
const SPOTS = [
  { left: 4, top: 14 },
  { left: 30, top: 50 },
  { left: 54, top: 6 },
  { left: 72, top: 46 },
];

function Pic({ loc, className }) {
  return loc.imageUrl
    ? <img src={assetUrl(loc.imageUrl)} alt="" className={`${className} object-contain`} />
    : <Building code={loc.code} label={loc.name} className={className} />;
}

export default function Locations({ active, onBalance }) {
  const [view, setView] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { ok, text }
  const [openId, setOpenId] = useState(null);

  const load = useCallback(async () => {
    try {
      const v = await getLocations();
      setView(v);
      onBalance(v.balance);
    } catch {
      setMsg({ ok: false, text: 'Не удалось загрузить локации' });
    }
  }, [onBalance]);

  // Обновляем при открытии и каждые 20 секунд: доход копится со временем.
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

  const open = view.locations.find((l) => l.id === openId);

  return (
    <div className="loc-screen">
      <h1 className="loc-title">Карта локаций</h1>

      <div className="loc-stats">
        <span><small className="is-gold">За тап</small><b><Coin className="loc-coin" />+{fmt(view.tapPower)}</b></span>
        <span><small className="is-blue">До новой лиги</small><b>{view.coinsToNext === null ? 'макс.' : short(view.coinsToNext)}</b></span>
        <span><small className="is-green">Доход в час</small><b><Coin className="loc-coin" />+{short(view.profitPerHour)}</b></span>
      </div>

      <div className="loc-map" role="list" aria-label="Карта локаций">
        <span className="loc-map-tag">КАРТА ЛОКАЦИЙ</span>
        {view.locations.slice(0, SPOTS.length).map((l, i) => (
          <button key={l.id} type="button" role="listitem" className={`loc-spot ${l.level === 0 ? 'is-locked' : ''}`}
            style={{ left: `${SPOTS[i].left}%`, top: `${SPOTS[i].top}%` }} onClick={() => setOpenId(l.id)}>
            <Pic loc={l} className="loc-spot-pic" />
            <span className="loc-spot-label">{l.name}{l.level > 0 ? ` · ${l.level}` : ''}</span>
          </button>
        ))}
      </div>

      <button type="button" className="loc-collect" disabled={busy || view.pendingTotal === 0}
        onClick={() => act(collectLocations, (r) => `Собрано +${fmt(r.collected)}`)}>
        Собрать доход <Coin className="loc-coin" /> +{fmt(view.pendingTotal)}
      </button>
      <p className="loc-hint">Доход копится не дольше {view.capHours} ч — заходи собирать вовремя.</p>
      <p className={`loc-msg ${msg?.ok ? 'is-ok' : 'is-error'}`}>{msg?.text}</p>

      <div className="loc-cards">
        {view.locations.map((l) => (
          <button key={l.id} type="button" className="loc-card" onClick={() => setOpenId(l.id)}>
            <span className="loc-card-top">
              <Pic loc={l} className="loc-card-pic" />
              <span className="loc-card-name">{l.level === 0 ? l.name : `Управление: ${l.name}`}</span>
            </span>
            <span className="loc-card-bottom">
              <span className="loc-card-lvl">{l.level === 0 ? 'нет' : `lvl ${l.level}`}</span>
              <span className="loc-card-price">
                {l.upgradeCost === null ? 'макс.' : <><Coin className="loc-coin" />{short(l.upgradeCost)}</>}
              </span>
            </span>
          </button>
        ))}
      </div>

      {open && (
        <Sheet onClose={() => setOpenId(null)}>
            <div className="flex items-center gap-3">
              <Pic loc={open} className="h-16 w-20 shrink-0" />
              <div className="min-w-0">
                <p className="text-lg font-bold">{open.name}</p>
                <p className="text-sm text-slate-400">
                  {open.level === 0 ? 'Ещё не куплено' : `Уровень ${open.level} из ${open.maxLevel}`}
                </p>
              </div>
            </div>
            <div className="mt-4 space-y-1.5 text-sm">
              <p className="flex justify-between"><span className="text-slate-400">Доход сейчас</span><b>+{fmt(open.incomePerHour)}/ч</b></p>
              {open.nextIncome !== null && (
                <p className="flex justify-between"><span className="text-slate-400">После прокачки</span><b className="text-emerald-300">+{fmt(open.nextIncome)}/ч</b></p>
              )}
              {open.level > 0 && (
                <p className="flex justify-between"><span className="text-slate-400">Накоплено</span><b>{fmt(open.pending)} из {fmt(open.pendingMax)}</b></p>
              )}
            </div>
            {open.upgradeCost === null ? (
              <p className="mt-4 text-center text-sm text-amber-300">Максимальный уровень</p>
            ) : (
              <button type="button" disabled={busy || view.balance + open.pending < open.upgradeCost}
                onClick={() => act(() => upgradeLocation(open.id),
                  (r) => (r.level === 1 ? `Куплено: ${open.name}` : `${open.name}: уровень ${r.level}`))}
                className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-yellow-400 py-3 font-semibold text-slate-950 active:bg-yellow-300 disabled:opacity-50">
                {open.level === 0 ? 'Купить за' : 'Прокачать за'} <Coin className="h-5 w-5" /> {fmt(open.upgradeCost)}
              </button>
            )}
            {msg && <p className={`mt-2 text-center text-sm ${msg.ok ? 'text-emerald-300' : 'text-red-400'}`}>{msg.text}</p>}
            <button type="button" onClick={() => setOpenId(null)} className="mt-3 w-full text-sm text-slate-400">Закрыть</button>
        </Sheet>
      )}
    </div>
  );
}
