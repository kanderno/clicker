import { useCallback, useEffect, useState } from 'react';
import { getEvents, getFreeBets, getMyBets, placeBet, placeFreeBet } from './api.js';
import Coin from './Coin.jsx';

const fmt = (n) => Number(n).toLocaleString('ru-RU');
const fmtDate = (iso) =>
  new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

const ERRORS = {
  event_closed: 'Ставки на это событие уже закрыты',
  event_not_found: 'Событие не найдено',
  free_bet_unavailable: 'Эта бесплатная ставка уже недоступна',
  bad_option: 'Такого варианта нет',
  insufficient_funds: 'Недостаточно монет',
  other_option: 'Ты уже поставил на другой вариант этого события',
  bad_amount: 'Введи целое число больше нуля',
  db_error: 'Ошибка сервера, попробуй ещё раз',
};
const errText = (e) => ERRORS[e.message] || 'Не получилось, проверь сумму и попробуй ещё раз';

export default function Predictions({ active, balance, onBalance }) {
  const [events, setEvents] = useState(null);
  const [sel, setSel] = useState(null); // { eventId, optionId }
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { eventId, ok, text }
  const [loadError, setLoadError] = useState(false);
  const [history, setHistory] = useState([]);
  const [freeBets, setFreeBets] = useState([]);

  const load = useCallback(async () => {
    try {
      const [ev, mine, fb] = await Promise.all([getEvents(), getMyBets(), getFreeBets()]);
      setEvents(ev.events);
      setHistory(mine.bets);
      setFreeBets(fb.freeBets);
      onBalance(mine.balance); // выплаты по закрытым событиям приходят на сервере: обновляем кошелёк
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [onBalance]);

  // Обновляем при открытии вкладки и каждые 20 секунд, пока она открыта.
  useEffect(() => {
    if (!active) return undefined;
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [active, load]);

  const submit = async () => {
    const value = Number(amount);
    if (!sel || !Number.isInteger(value) || value <= 0) {
      setMsg({ eventId: sel?.eventId, ok: false, text: ERRORS.bad_amount });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const r = await placeBet(sel.eventId, sel.optionId, value);
      onBalance(r.balance);
      setMsg({ eventId: sel.eventId, ok: true, text: `Ставка принята: всего ${fmt(r.myStake)}` });
      setSel(null);
      setAmount('');
      await load();
    } catch (e) {
      setMsg({ eventId: sel.eventId, ok: false, text: errText(e) });
      if (e.message === 'event_closed') load();
    } finally {
      setBusy(false);
    }
  };

  const submitFree = async (freeBetId) => {
    if (!sel) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await placeFreeBet(sel.eventId, sel.optionId, freeBetId);
      setMsg({ eventId: sel.eventId, ok: true, text: `Бесплатная ставка принята: всего ${fmt(r.myStake)}` });
      setSel(null);
      setAmount('');
      await load();
    } catch (e) {
      setMsg({ eventId: sel.eventId, ok: false, text: errText(e) });
      if (e.message === 'event_closed' || e.message === 'free_bet_unavailable') load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto px-4 py-6 text-white">
      <h1 className="text-center text-xl font-bold">Прогнозы</h1>
      <p className="mt-2 flex items-center justify-center gap-1.5 text-sm text-slate-400">
        Кошелёк: <Coin className="w-4 h-4" /> <span className="font-semibold text-yellow-400">{fmt(balance)}</span>
      </p>

      {freeBets.length > 0 && (
        <p className="mt-2 text-center text-xs text-emerald-300">
          Бесплатных ставок: {freeBets.length} (выбери вариант и используй их)
        </p>
      )}

      {events === null && !loadError && <p className="mt-6 text-center text-sm text-slate-500">Загрузка…</p>}
      {loadError && <p className="mt-6 text-center text-sm text-red-400">Не удалось загрузить события</p>}
      {events?.length === 0 && (
        <p className="mt-6 text-center text-sm text-slate-500">Пока нет открытых событий. Загляни позже.</p>
      )}

      <div className="mt-4 space-y-4 pb-4">
        {events?.map((ev) => {
          const mine = ev.myBet;
          const panelOpen = sel?.eventId === ev.id && ev.bettingOpen;
          // При фиксированном коэффициенте выплату можно показать сразу, до закрытия события.
          const selOdds = panelOpen && ev.payoutMode === 'odds'
            ? ev.options.find((o) => o.id === sel.optionId)?.multiplier ?? null
            : null;
          const stake = Number(amount);
          const potential = selOdds && Number.isInteger(stake) && stake > 0
            ? Math.floor(stake * selOdds)
            : null;
          return (
            <div key={ev.id} className="rounded-2xl bg-slate-800/70 p-4">
              <p className="font-semibold leading-snug">{ev.title}</p>
              {ev.description && <p className="mt-1 text-sm text-slate-400">{ev.description}</p>}
              <p className={`mt-2 text-xs ${ev.bettingOpen ? 'text-slate-500' : 'text-amber-400'}`}>
                {ev.bettingOpen ? `Ставки до ${fmtDate(ev.deadline)}` : 'Ставки закрыты, ждём результат'}
                {' · '}банк: {fmt(ev.totalPool)}
                {ev.payoutMode === 'odds' && <span className="text-yellow-300"> · фикс. коэффициент</span>}
              </p>

              <div className="mt-3 space-y-2">
                {ev.options.map((o) => {
                  const isMine = mine?.optionId === o.id;
                  const locked = !ev.bettingOpen || (mine && !isMine);
                  const selected = sel?.eventId === ev.id && sel.optionId === o.id;
                  return (
                    <button
                      key={o.id}
                      type="button"
                      disabled={locked}
                      onClick={() => {
                        setSel(selected ? null : { eventId: ev.id, optionId: o.id });
                        setMsg(null);
                      }}
                      className={`flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm
                        ${selected ? 'bg-yellow-400/20 ring-1 ring-yellow-400' : isMine ? 'bg-emerald-500/15 ring-1 ring-emerald-500/50' : 'bg-slate-900/70'}
                        ${locked ? 'opacity-50' : 'active:bg-slate-700'}`}
                    >
                      <span>
                        {o.title}
                        {isMine && (
                          <span className="ml-2 text-xs text-emerald-300">
                            твоя ставка {fmt(mine.amount)}
                            {mine.freeAmount > 0 ? ` (бесплатно ${fmt(mine.freeAmount)})` : ''}
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 pl-3 text-right text-xs tabular-nums text-slate-400">
                        {fmt(o.pool)}
                        {o.multiplier ? <span className="ml-2 text-yellow-300">x{o.multiplier}</span> : null}
                      </span>
                    </button>
                  );
                })}
              </div>

              {mine && ev.bettingOpen && (
                <p className="mt-2 text-xs text-slate-500">Можно докинуть монет только на свой вариант.</p>
              )}

              {panelOpen && (
                <div className="mt-3 rounded-xl bg-slate-900/70 p-3">
                  <input
                    type="text"
                    inputMode="numeric"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value.replace(/\D/g, '').slice(0, 12))}
                    placeholder="Сумма ставки"
                    className="w-full rounded-lg bg-slate-950 px-3 py-2.5 text-white outline-none ring-1 ring-slate-700 focus:ring-yellow-400/70"
                  />
                  <div className="mt-2 flex gap-2 text-xs">
                    {[10, 100, 1000].map((v) => (
                      <button key={v} type="button" onClick={() => setAmount(String(v))}
                        className="rounded-lg bg-slate-700/60 px-3 py-1.5 text-slate-300 active:bg-slate-600">
                        {fmt(v)}
                      </button>
                    ))}
                    <button type="button" onClick={() => setAmount(String(balance))}
                      className="rounded-lg bg-slate-700/60 px-3 py-1.5 text-slate-300 active:bg-slate-600">
                      всё
                    </button>
                  </div>
                  {selOdds && (
                    <p className="mt-2 text-xs text-slate-400">
                      Коэффициент <span className="text-yellow-300">x{selOdds}</span>
                      {potential !== null && <> · выплата при победе: <span className="text-yellow-300">{fmt(potential)}</span></>}
                    </p>
                  )}

                  <button type="button" disabled={busy} onClick={submit}
                    className="mt-3 w-full rounded-xl bg-yellow-400 py-2.5 font-semibold text-slate-950 active:bg-yellow-300 disabled:opacity-50">
                    Поставить
                  </button>

                  {freeBets.length > 0 && (
                    <div className="mt-3 border-t border-slate-700/60 pt-3">
                      <p className="text-xs text-slate-400">Или бесплатная ставка (монеты не списываются):</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {freeBets.map((f) => (
                          <button key={f.id} type="button" disabled={busy} onClick={() => submitFree(f.id)}
                            className="rounded-lg bg-emerald-500/20 px-3 py-2 text-sm font-semibold text-emerald-300 ring-1 ring-emerald-500/40 active:bg-emerald-500/30 disabled:opacity-50">
                            Бесплатно {fmt(f.amount)}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {msg?.eventId === ev.id && (
                <p className={`mt-2 text-sm ${msg.ok ? 'text-emerald-300' : 'text-red-400'}`}>{msg.text}</p>
              )}
            </div>
          );
        })}
      </div>


      {history.length > 0 && (
        <div className="pb-4">
          <p className="text-sm font-semibold text-slate-300">Мои ставки</p>
          <div className="mt-3 space-y-2">
            {history.map((b) => {
              const chip = {
                pending: { text: 'ждём результат', cls: 'bg-slate-600/40 text-slate-300' },
                won: { text: `выиграл +${fmt(b.profit)}`, cls: 'bg-emerald-500/20 text-emerald-300' },
                lost: b.cashAmount > 0
                  ? { text: `проиграл −${fmt(b.cashAmount)}`, cls: 'bg-red-500/20 text-red-300' }
                  : { text: 'бесплатная ставка не сыграла', cls: 'bg-slate-600/40 text-slate-300' },
                refunded: {
                  text: b.freeAmount > 0 ? 'возврат: бесплатная ставка вернулась тебе' : 'ставка возвращена',
                  cls: 'bg-amber-500/20 text-amber-300',
                },
              }[b.result];
              return (
                <div key={b.id} className="rounded-xl bg-slate-800/70 px-3 py-2.5">
                  <p className="text-sm leading-snug">{b.eventTitle}</p>
                  <p className="mt-0.5 text-xs text-slate-400">
                    Твоя ставка: {fmt(b.amount)}{b.freeAmount > 0 ? ` (бесплатно ${fmt(b.freeAmount)})` : ''} на «{b.optionTitle}»
                    {b.winningOptionTitle ? ` · победило «${b.winningOptionTitle}»` : ''}
                  </p>
                  <span className={`mt-1.5 inline-block rounded-md px-2 py-0.5 text-xs ${chip.cls}`}>{chip.text}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <p className="pb-2 text-center text-xs text-slate-500">
        «Фикс. коэффициент» — выплата известна заранее: ставка × коэффициент. У остальных событий множитель
        ориентировочный: он меняется, пока другие делают ставки, итог считается при закрытии события.
      </p>
    </div>
  );
}
