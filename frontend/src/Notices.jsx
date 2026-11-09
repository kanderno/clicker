const fmt = (n) => Number(n).toLocaleString('ru-RU');

// Как показывать уведомление каждого вида: знак суммы, цвет и подпись.
const KINDS = {
  bet_win: { sign: '+', cls: 'text-emerald-300', text: (n) => `Ставка сыграла на «${n.body}»` },
  bet_lost: { sign: '−', cls: 'text-red-300', text: (n) => `Ставка на «${n.body}» не сыграла` },
  bet_refund: { sign: '↩ ', cls: 'text-amber-300', text: () => 'Событие отменено, ставка вернулась' },
};
const FALLBACK = { sign: '', cls: 'text-yellow-300', text: (n) => n.body || '' };

function headline(list) {
  if (list.every((n) => n.kind === 'bet_win')) return { text: 'Ставка выиграла!', cls: 'text-emerald-400' };
  if (list.every((n) => n.kind === 'bet_lost')) return { text: 'Ставка проиграла', cls: 'text-red-400' };
  return { text: 'Новости по твоим монетам', cls: 'text-yellow-300' };
}

export default function NoticesModal({ list, onClose }) {
  const head = headline(list);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 px-6 backdrop-blur-sm">
      <div className="notice-card w-full max-w-sm rounded-2xl bg-slate-800 p-6 text-center text-white shadow-2xl">
        <p className={`text-xl font-bold ${head.cls}`}>{head.text}</p>
        <div className="mt-3 max-h-64 space-y-2 overflow-y-auto">
          {list.map((n) => {
            const k = KINDS[n.kind] ?? FALLBACK;
            return (
              <div key={n.id} className="rounded-xl bg-slate-900/70 px-3 py-2 text-left text-sm">
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0 break-words font-semibold">{n.title}</span>
                  {n.amount > 0 && (
                    <b className={`shrink-0 tabular-nums ${k.cls}`}>{k.sign}{fmt(n.amount)}</b>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-slate-400">{k.text(n)}</p>
              </div>
            );
          })}
        </div>
        <button type="button" onClick={onClose}
          className="mt-5 w-full rounded-xl bg-yellow-400 py-3 font-semibold text-slate-950 active:bg-yellow-300">
          Понятно
        </button>
      </div>
    </div>
  );
}
