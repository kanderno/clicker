import { useCallback, useEffect, useState } from 'react';
import { adminCancelEvent, adminCreateEvent, adminDeleteEvent, adminListEvents, adminResolveEvent } from './api.js';
import AdminCoins from './AdminCoins.jsx';

const ERRORS = {
  bad_title: 'Название: от 3 до 200 символов',
  bad_options: 'Нужно от 2 до 10 разных вариантов (до 100 символов)',
  bad_deadline: 'Дедлайн должен быть в будущем',
  bad_odds: 'Коэффициент нужен у каждого варианта: число от 1.01 до 1000',
  bad_mode: 'Неизвестный режим выплат',
  forbidden: 'Нет доступа',
  event_has_bets: 'На это событие уже есть ставки, удалить нельзя',
  bad_option: 'Такого варианта нет в этом событии',
  event_not_found: 'Событие не найдено',
  db_error: 'Ошибка сервера, попробуй ещё раз',
};
const errText = (e) => ERRORS[e.message] || `Ошибка: ${e.message}`;

const pad = (n) => String(n).padStart(2, '0');
const toLocalInput = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const defaultDeadline = () => toLocalInput(new Date(Date.now() + 24 * 3600 * 1000));

const STATUS = {
  open: { text: 'открыто', cls: 'bg-emerald-500/20 text-emerald-300' },
  resolved: { text: 'завершено', cls: 'bg-slate-600/40 text-slate-300' },
  cancelled: { text: 'отменено', cls: 'bg-red-500/20 text-red-300' },
};

const inputCls =
  'w-full rounded-xl bg-slate-900 px-3 py-2.5 text-white outline-none ring-1 ring-slate-700 focus:ring-yellow-400/70';

// Коэффициент: число от 1.01 до 1000, не больше двух знаков после точки.
const parseOdds = (s) => {
  const v = Number(String(s).replace(',', '.'));
  return Number.isFinite(v) && v >= 1.01 && v <= 1000 ? Math.round(v * 100) / 100 : null;
};

export default function Admin({ active }) {
  const [events, setEvents] = useState(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [deadline, setDeadline] = useState(defaultDeadline);
  const [options, setOptions] = useState(['Да', 'Нет']);
  // payoutMode: 'odds' — выплата = ставка x коэффициент; 'pool' — тотализатор (банк делится между победителями)
  const [payoutMode, setPayoutMode] = useState('odds');
  const [odds, setOdds] = useState(['2', '2']);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { ok, text }
  const [confirmId, setConfirmId] = useState(null);
  // pending: { eventId, kind: 'pick' | 'resolve' | 'cancel', optionId? }: шаги закрытия события с подтверждением
  const [pending, setPending] = useState(null);
  const [closing, setClosing] = useState(false);

  const load = useCallback(async () => {
    try {
      setEvents((await adminListEvents()).events);
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    }
  }, []);

  useEffect(() => {
    if (active) load();
  }, [active, load]);

  const setOption = (i, v) => setOptions((o) => o.map((x, j) => (j === i ? v : x)));
  const setOdd = (i, v) => setOdds((o) => o.map((x, j) => (j === i ? v : x)));
  // Вариант и его коэффициент добавляются/удаляются вместе, чтобы индексы не разъехались.
  const addOption = () => {
    setOptions((x) => [...x, '']);
    setOdds((x) => [...x, '2']);
  };
  const removeOption = (i) => {
    setOptions((x) => x.filter((_, j) => j !== i));
    setOdds((x) => x.filter((_, j) => j !== i));
  };

  const create = async () => {
    const when = new Date(deadline);
    if (Number.isNaN(when.getTime())) {
      setMsg({ ok: false, text: 'Укажи дедлайн' });
      return;
    }
    let parsedOdds = null;
    if (payoutMode === 'odds') {
      parsedOdds = options.map((_, i) => parseOdds(odds[i]));
      if (parsedOdds.some((x) => x === null)) {
        setMsg({ ok: false, text: ERRORS.bad_odds });
        return;
      }
    }
    setBusy(true);
    setMsg(null);
    try {
      await adminCreateEvent({
        title: title.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        deadline: when.toISOString(),
        options: options.map((o) => o.trim()),
        payoutMode,
        ...(parsedOdds ? { odds: parsedOdds } : {}),
      });
      setTitle('');
      setDescription('');
      setDeadline(defaultDeadline());
      setOptions(['Да', 'Нет']);
      setOdds(['2', '2']);
      setMsg({ ok: true, text: 'Событие создано' });
      await load();
    } catch (e) {
      // ошибки схемы (400 от Fastify) приходят без нашего кода — показываем понятный текст
      setMsg({ ok: false, text: ERRORS[e.message] || 'Проверь поля: название от 3 символов, варианты не пустые' });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id) => {
    if (confirmId !== id) {
      setConfirmId(id);
      return;
    }
    setConfirmId(null);
    try {
      await adminDeleteEvent(id);
      setMsg({ ok: true, text: 'Событие удалено' });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    }
  };

  const finish = async (fn, doneText) => {
    setClosing(true);
    setMsg(null);
    try {
      const r = await fn();
      setPending(null);
      setMsg({
        ok: true,
        text: !r.changed
          ? 'Событие уже было закрыто раньше, ничего не изменилось'
          : doneText(r),
      });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setClosing(false);
    }
  };

  const doResolve = (ev, optionId) =>
    finish(
      () => adminResolveEvent(ev.id, optionId),
      (r) =>
        r.refunded
          ? `На выбранный вариант никто не ставил, всем возвращено ${Number(r.paidOut).toLocaleString('ru-RU')}`
          : `Событие закрыто, выплачено ${Number(r.paidOut).toLocaleString('ru-RU')}`,
    );

  const doCancel = (ev) =>
    finish(
      () => adminCancelEvent(ev.id),
      (r) => `Событие отменено, возвращено ${Number(r.paidOut).toLocaleString('ru-RU')}`,
    );

  return (
    <div className="h-full overflow-y-auto px-4 py-6 text-white">
      <h1 className="text-center text-xl font-bold">Админка</h1>

      <div className="mt-5 space-y-3 rounded-2xl bg-slate-800/70 p-4">
        <p className="text-sm font-semibold text-slate-300">Новое событие</p>
        <input className={inputCls} placeholder="Вопрос, например: Случится ли X до конца недели?"
          value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
        <textarea className={`${inputCls} resize-none`} rows={2} placeholder="Описание (необязательно)"
          value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} />
        <label className="block text-xs text-slate-400">
          Дедлайн ставок (твоё локальное время)
          <input type="datetime-local" className={`${inputCls} mt-1`} value={deadline}
            onChange={(e) => setDeadline(e.target.value)} />
        </label>

        <div className="space-y-2">
          <p className="text-xs text-slate-400">Как считать выплату</p>
          <div className="flex gap-2 text-sm">
            {[
              ['odds', 'Коэффициенты'],
              ['pool', 'Тотализатор'],
            ].map(([v, label]) => (
              <button key={v} type="button" onClick={() => setPayoutMode(v)}
                className={`flex-1 rounded-xl py-2 font-semibold ${
                  payoutMode === v ? 'bg-yellow-400 text-slate-950' : 'bg-slate-900 text-slate-300 active:bg-slate-700'
                }`}>
                {label}
              </button>
            ))}
          </div>
          <p className="text-xs text-slate-500">
            {payoutMode === 'odds'
              ? 'Выплата = ставка × коэффициент варианта. Известна игроку заранее; разницу доплачивает казино.'
              : 'Весь банк события делится между теми, кто угадал, пропорционально ставкам.'}
          </p>
        </div>

        <div className="space-y-2">
          <p className="text-xs text-slate-400">
            Варианты исхода (2–10){payoutMode === 'odds' ? ' и коэффициенты' : ''}
          </p>
          {options.map((o, i) => (
            <div key={i} className="flex gap-2">
              <input className={inputCls} placeholder={`Вариант ${i + 1}`} value={o} maxLength={100}
                onChange={(e) => setOption(i, e.target.value)} />
              {payoutMode === 'odds' && (
                <input type="text" inputMode="decimal" aria-label={`Коэффициент варианта ${i + 1}`}
                  className={`${inputCls} w-24 shrink-0 text-center tabular-nums`} placeholder="2.00"
                  value={odds[i] ?? ''} maxLength={7}
                  onChange={(e) => setOdd(i, e.target.value.replace(/[^\d.,]/g, '').slice(0, 7))} />
              )}
              {options.length > 2 && (
                <button type="button" onClick={() => removeOption(i)}
                  className="rounded-xl bg-slate-700 px-3 text-slate-300 active:bg-slate-600" aria-label="Убрать">
                  ✕
                </button>
              )}
            </div>
          ))}
          {options.length < 10 && (
            <button type="button" onClick={addOption}
              className="text-sm text-yellow-400 active:text-yellow-300">
              + добавить вариант
            </button>
          )}
          {payoutMode === 'odds' && (
            <p className="text-xs text-slate-500">
              Коэффициент от 1.01 до 1000. Ставка 100 при кэфе 1.80 вернёт игроку 180.
            </p>
          )}
        </div>

        <button type="button" disabled={busy} onClick={create}
          className="w-full rounded-xl bg-yellow-400 py-3 font-semibold text-slate-950 active:bg-yellow-300 disabled:opacity-50">
          Создать событие
        </button>
        <p className={`h-5 text-center text-sm ${msg?.ok ? 'text-emerald-300' : 'text-red-400'}`}>{msg?.text}</p>
      </div>

      <AdminCoins active={active} />

      <p className="mt-6 text-sm font-semibold text-slate-300">События</p>
      {events === null && <p className="mt-3 text-sm text-slate-500">Загрузка…</p>}
      {events?.length === 0 && <p className="mt-3 text-sm text-slate-500">Пока нет ни одного события</p>}

      <div className="mt-3 space-y-3 pb-4">
        {events?.map((ev) => {
          const st = STATUS[ev.status] || STATUS.open;
          return (
            <div key={ev.id} className="rounded-2xl bg-slate-800/70 p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="font-semibold leading-snug">{ev.title}</p>
                <span className={`shrink-0 rounded-md px-2 py-0.5 text-xs ${st.cls}`}>{st.text}</span>
              </div>
              {ev.description && <p className="mt-1 text-sm text-slate-400">{ev.description}</p>}
              <p className="mt-2 text-xs text-slate-500">
                Дедлайн: {new Date(ev.deadline).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}
                {' · '}{ev.payout_mode === 'odds' ? 'коэффициенты' : 'тотализатор'}
              </p>
              <ul className="mt-2 space-y-1">
                {ev.options.map((o) => (
                  <li key={o.id}
                    className={`flex justify-between gap-3 rounded-lg px-3 py-1.5 text-sm ${
                      ev.winning_option_id === o.id ? 'bg-emerald-500/20 ring-1 ring-emerald-500/50' : 'bg-slate-900/60'
                    }`}>
                    <span className="truncate">{ev.winning_option_id === o.id ? '✓ ' : ''}{o.title}</span>
                    <span className="shrink-0 tabular-nums text-slate-400">
                      {o.odds !== null && o.odds !== undefined && (
                        <span className="mr-2 text-yellow-300">x{Number(o.odds)}</span>
                      )}
                      пул: {Number(o.pool).toLocaleString('ru-RU')}
                    </span>
                  </li>
                ))}
              </ul>
              {ev.status === 'resolved' && ev.refunded && (
                <p className="mt-2 text-xs text-amber-300">На победителя никто не ставил, ставки возвращены.</p>
              )}
              {ev.status === 'cancelled' && (
                <p className="mt-2 text-xs text-amber-300">Событие отменено, ставки возвращены.</p>
              )}

              {ev.status === 'open' && (
                <div className="mt-3 border-t border-slate-700/60 pt-3">
                  {pending?.eventId !== ev.id && (
                    <div className="flex gap-4 text-sm">
                      <button type="button" onClick={() => setPending({ eventId: ev.id, kind: 'pick' })}
                        className="font-semibold text-yellow-400 active:text-yellow-300">
                        Закрыть и выбрать победителя
                      </button>
                      <button type="button" onClick={() => setPending({ eventId: ev.id, kind: 'cancel' })}
                        className="text-slate-400 active:text-slate-300">
                        Отменить
                      </button>
                    </div>
                  )}

                  {pending?.eventId === ev.id && pending.kind === 'pick' && (
                    <div>
                      <p className="text-xs text-slate-400">Кто победил?</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {ev.options.map((o) => (
                          <button key={o.id} type="button"
                            onClick={() => setPending({ eventId: ev.id, kind: 'resolve', optionId: o.id })}
                            className="rounded-lg bg-slate-700 px-3 py-1.5 text-sm active:bg-slate-600">
                            {o.title}
                          </button>
                        ))}
                      </div>
                      <button type="button" onClick={() => setPending(null)} className="mt-2 text-xs text-slate-500">
                        Назад
                      </button>
                    </div>
                  )}

                  {pending?.eventId === ev.id && pending.kind === 'resolve' && (
                    <div>
                      <p className="text-sm">
                        Победил: <b className="text-yellow-300">{ev.options.find((o) => o.id === pending.optionId)?.title}</b>.
                        Выплаты нельзя отменить.
                        {new Date(ev.deadline) > new Date() && (
                          <span className="text-amber-300"> Дедлайн ещё не наступил!</span>
                        )}
                      </p>
                      <div className="mt-2 flex gap-3">
                        <button type="button" disabled={closing} onClick={() => doResolve(ev, pending.optionId)}
                          className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 active:bg-emerald-400 disabled:opacity-50">
                          Подтвердить и выплатить
                        </button>
                        <button type="button" onClick={() => setPending(null)} className="text-sm text-slate-400">
                          Отмена
                        </button>
                      </div>
                    </div>
                  )}

                  {pending?.eventId === ev.id && pending.kind === 'cancel' && (
                    <div>
                      <p className="text-sm">Отменить событие и вернуть все ставки игрокам?</p>
                      <div className="mt-2 flex gap-3">
                        <button type="button" disabled={closing} onClick={() => doCancel(ev)}
                          className="rounded-lg bg-red-500 px-4 py-2 text-sm font-semibold text-white active:bg-red-400 disabled:opacity-50">
                          Да, отменить
                        </button>
                        <button type="button" onClick={() => setPending(null)} className="text-sm text-slate-400">
                          Назад
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <button type="button" onClick={() => remove(ev.id)}
                className={`mt-3 block text-xs ${confirmId === ev.id ? 'text-red-400 font-semibold' : 'text-slate-500'}`}>
                {confirmId === ev.id ? 'Точно удалить? Нажми ещё раз' : 'Удалить (если нет ставок)'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
