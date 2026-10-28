// Загрузка событий с вариантами двумя простыми запросами.
// Один запрос с вложением (event_options(...)) не работает: между events и event_options
// две связи (event_id и winning_option_id), и PostgREST не знает, какую выбрать.
export async function listEventsWithOptions(
  client,
  { limit = 50, statuses = null, orderBy = 'created_at', ascending = false } = {},
) {
  let q = client
    .from('events')
    .select(
      'id, title, description, deadline, status, payout_mode, winning_option_id, refunded, created_at, resolved_at',
    )
    .order(orderBy, { ascending })
    .limit(limit);
  if (statuses) q = q.in('status', statuses);

  const { data: events, error } = await q;
  if (error) return { error };
  if (!events.length) return { events: [] };

  const { data: options, error: optErr } = await client
    .from('event_options')
    .select('id, event_id, title, pool, odds, position')
    .in('event_id', events.map((e) => e.id))
    .order('position', { ascending: true });
  if (optErr) return { error: optErr };

  const byEvent = new Map();
  for (const { event_id, ...o } of options) {
    if (!byEvent.has(event_id)) byEvent.set(event_id, []);
    byEvent.get(event_id).push(o);
  }
  return { events: events.map((e) => ({ ...e, options: byEvent.get(e.id) ?? [] })) };
}

// Вид события для игрока.
//  * режим 'odds': множитель — это фиксированный коэффициент варианта, выплата известна заранее;
//  * режим 'pool' (тотализатор): множитель ориентировочный, он плывёт вместе с банком,
//    итог считается при закрытии события.
export function toPlayerView(events, myBets, now = Date.now()) {
  return events.map((e) => {
    const totalPool = e.options.reduce((sum, o) => sum + Number(o.pool), 0);
    const fixedOdds = e.payout_mode === 'odds';
    return {
      id: e.id,
      title: e.title,
      description: e.description,
      deadline: e.deadline,
      bettingOpen: new Date(e.deadline).getTime() > now,
      payoutMode: fixedOdds ? 'odds' : 'pool',
      totalPool,
      myBet: myBets.get(e.id) ?? null,
      options: e.options.map((o) => ({
        id: o.id,
        title: o.title,
        pool: Number(o.pool),
        multiplier: fixedOdds
          ? (o.odds === null || o.odds === undefined ? null : Number(o.odds))
          : Number(o.pool) > 0
            ? Math.round((totalPool / Number(o.pool)) * 100) / 100
            : null,
      })),
    };
  });
}

// История ставок игрока: результат считается по данным, записанным при закрытии события.
// cash = настоящие монеты игрока в ставке (без бесплатной части). Прибыль считается от них.
export function toMyBetsView(bets, eventsById, optionsById) {
  return bets.map((b) => {
    const ev = eventsById.get(b.event_id);
    const amount = Number(b.amount);
    const freeAmount = Number(b.free_amount ?? 0);
    const cashAmount = amount - freeAmount;
    const payout = b.payout === null || b.payout === undefined ? null : Number(b.payout);

    let result = 'pending';
    if (ev?.status === 'cancelled') result = 'refunded';
    else if (ev?.status === 'resolved' && payout !== null) {
      if (ev.refunded) result = 'refunded';
      else result = payout > 0 ? 'won' : 'lost';
    }

    return {
      id: b.id,
      eventTitle: ev?.title ?? '(событие удалено)',
      optionTitle: optionsById.get(b.option_id)?.title ?? '',
      winningOptionTitle: ev?.winning_option_id ? optionsById.get(ev.winning_option_id)?.title ?? null : null,
      amount,
      freeAmount,
      cashAmount,
      payout,
      profit: payout === null ? null : payout - cashAmount,
      result,
    };
  });
}
