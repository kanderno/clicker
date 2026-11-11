// Сборка ответа лидерборда. Места и балансы приходят из SQL (leaderboard_view), лиги — из таблицы leagues.
const toPlayer = (r, myId) => ({
  id: r.user_id,
  place: Number(r.place),
  username: r.username,
  firstName: r.first_name,
  photoUrl: r.photo_url,
  balance: Number(r.balance),
  vip: Boolean(r.vip),
  isMe: r.user_id === myId,
});

export function buildLeaderboard({ rows, leagues, myId, peak }) {
  const sorted = [...leagues]
    .map((l) => ({
      id: l.id,
      name: l.name,
      minPeak: Number(l.min_peak),
      rewards: [Number(l.reward_1), Number(l.reward_2), Number(l.reward_3)],
    }))
    .sort((a, b) => a.minPeak - b.minPeak);
  const myPeak = Number(peak);
  const current = sorted.filter((l) => l.minPeak <= myPeak).at(-1) ?? null;
  const next = sorted.find((l) => l.minPeak > myPeak) ?? null;

  const byScope = (scope) =>
    rows.filter((r) => r.scope === scope).map((r) => toPlayer(r, myId)).sort((a, b) => a.place - b.place);

  return {
    league: current,
    nextLeague: next,
    coinsToNext: next ? next.minPeak - myPeak : null,
    leagues: sorted,
    local: byScope('league'),
    global: byScope('global'),
  };
}
