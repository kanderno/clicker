// Сборка ответа для экрана майнеров. Все числа (доход, накопления, цены) приходят из SQL-функций:
// здесь только объединение данных и флаги для интерфейса.
export function buildMinersView({ balance, parts, inventory, types, recipes, overview, config }) {
  const have = new Map(inventory.map((i) => [i.part_type_id, Number(i.qty)]));
  const partName = new Map(parts.map((p) => [p.id, p.name]));
  const miners = overview.map((o) => ({
    id: o.miner_id,
    typeId: o.type_id,
    name: o.type_name,
    level: o.level,
    maxLevel: o.max_level,
    incomePerHour: Number(o.income_per_hour),
    pending: Number(o.pending),
    pendingMax: Number(o.pending_max),
    upgradeCost: o.upgrade_cost === null ? null : Number(o.upgrade_cost),
  }));
  const canBuildMore = miners.length < config.max_miners;

  return {
    balance: Number(balance),
    capHours: config.cap_hours,
    maxMiners: config.max_miners,
    canBuildMore,
    parts: parts.map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      shopPrice: Number(p.shop_price),
      qty: have.get(p.id) ?? 0,
    })),
    types: types.map((t) => {
      const recipe = recipes
        .filter((r) => r.miner_type_id === t.id)
        .map((r) => ({
          partId: r.part_type_id,
          partName: partName.get(r.part_type_id) ?? '?',
          qty: r.qty,
          have: have.get(r.part_type_id) ?? 0,
        }));
      return {
        id: t.id,
        code: t.code,
        name: t.name,
        baseIncome: Number(t.base_income),
        maxLevel: t.max_level,
        recipe,
        canBuild: canBuildMore && recipe.length > 0 && recipe.every((r) => r.have >= r.qty),
      };
    }),
    miners,
    pendingTotal: miners.reduce((sum, m) => sum + m.pending, 0),
  };
}
