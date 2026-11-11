// Настройки игры, которые админ меняет из приложения. Значения по умолчанию совпадают с SQL-функциями
// (setting_num(key, default)), границы защищают экономику от опечаток.
export const SETTINGS = {
  wheel_price: { def: 150, min: 1, max: 1e12, int: true },
  wheel_max_paid: { def: 5, min: 0, max: 100, int: true },
  steal_price: { def: 1000, min: 1, max: 1e12, int: true },
  steal_max_charges: { def: 20, min: 1, max: 1000, int: true },
  steal_pct_min: { def: 2, min: 0.1, max: 100 },
  steal_pct_max: { def: 10, min: 0.1, max: 100 },
  steal_cap: { def: 0, min: 0, max: 1e12, int: true },
  steal_min_balance: { def: 100, min: 0, max: 1e12, int: true },
  steal_newbie_hours: { def: 24, min: 0, max: 720, int: true },
  steal_victim_cap: { def: 3, min: 0, max: 1000, int: true },
  tap_boost_mult: { def: 2, min: 1, max: 10, int: true },
  vip_wheel_discount: { def: 50, min: 0, max: 100, int: true },
  tap_upgrade_base: { def: 200, min: 1, max: 1e12, int: true },
  tap_upgrade_growth: { def: 1.35, min: 1, max: 10 },
  tap_max_level: { def: 30, min: 1, max: 1000, int: true },
  locations_cap_hours: { def: 3, min: 0.5, max: 168 },
  location_price_growth: { def: 1.6, min: 1, max: 10 },
  location_income_growth: { def: 1.4, min: 1, max: 10 },
};

export const DEFAULT_STREAK = [
  { coins: 100 }, { coins: 250 }, { spins: 1 }, { coins: 500 }, { coins: 1000, boost: 30 },
  { coins: 1500, spins: 1 }, { coins: 3000, steals: 1, vip: 24 },
];

// Награда дня стрика: монеты, бонусные спины, заряды кражи, буст удара (минут), VIP (часов).
const STREAK_LIMITS = { coins: 1e12, spins: 100, steals: 100, boost: 1440, vip: 720 };

// Вкладки нижнего меню, у которых админ может заменить иконку.
export const NAV_TABS = ['game', 'gift', 'bets', 'wheel', 'locations', 'bank', 'admin'];

const IMAGE_URL = /^(\/img\/\d{1,12}|https:\/\/[^\s"'<>]{1,490})$/;
export const isImageUrl = (v) => v === null || (typeof v === 'string' && IMAGE_URL.test(v));

// Текущие значения: из таблицы settings, иначе по умолчанию.
export function settingsView(rows) {
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const out = {};
  for (const [key, spec] of Object.entries(SETTINGS)) out[key] = Number(byKey.get(key) ?? spec.def);
  out.streak_rewards = byKey.get('streak_rewards') ?? DEFAULT_STREAK;
  out.logo_url = byKey.get('logo_url') ?? null;
  out.coin_url = byKey.get('coin_url') ?? null;
  out.nav_icons = byKey.get('nav_icons') ?? {};
  return out;
}

function cleanStreak(list) {
  if (!Array.isArray(list) || list.length < 1 || list.length > 14) return null;
  const out = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') return null;
    const day = {};
    for (const [k, max] of Object.entries(STREAK_LIMITS)) {
      const v = r[k] ?? 0;
      if (!Number.isInteger(v) || v < 0 || v > max) return null;
      if (v > 0) day[k] = v;
    }
    out.push(day);
  }
  return out;
}

// Проверка изменений от админа. Возвращает { rows } для upsert в settings или { error }.
// current — текущие значения (нужны, чтобы min процента кражи не оказался больше max).
export function validateSettings(body, current) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'bad_settings' };
  const rows = [];
  for (const [key, value] of Object.entries(body)) {
    const spec = SETTINGS[key];
    if (spec) {
      const ok = typeof value === 'number' && Number.isFinite(value) && value >= spec.min && value <= spec.max
        && (!spec.int || Number.isInteger(value));
      if (!ok) return { error: 'bad_setting', key };
      rows.push({ key, value });
    } else if (key === 'streak_rewards') {
      const list = cleanStreak(value);
      if (!list) return { error: 'bad_setting', key };
      rows.push({ key, value: list });
    } else if (key === 'nav_icons') {
      const ok = value && typeof value === 'object' && !Array.isArray(value)
        && Object.entries(value).every(([tab, url]) => NAV_TABS.includes(tab) && isImageUrl(url));
      if (!ok) return { error: 'bad_setting', key };
      rows.push({ key, value: Object.fromEntries(Object.entries(value).filter(([, url]) => url)) });
    } else if (key === 'logo_url' || key === 'coin_url') {
      if (!isImageUrl(value)) return { error: 'bad_setting', key };
      rows.push({ key, value });
    } else {
      return { error: 'bad_setting', key };
    }
  }
  const merged = { ...current, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
  if (merged.steal_pct_min > merged.steal_pct_max) return { error: 'bad_setting', key: 'steal_pct_min' };
  return { rows };
}
