import { useCallback, useEffect, useState } from 'react';
import {
  adminCreateLeague, adminCreateLocation, adminCreatePrize, adminDeleteLeague, adminGetGame, adminSaveSettings,
  adminUpdateLeague, adminUpdateLocation, adminUpdatePrize, adminUploadImage, assetUrl,
} from './api.js';

const ERRORS = {
  bad_setting: 'Значение вне допустимых границ',
  bad_settings: 'Неверные настройки',
  bad_value: 'Проверь значения (например, у приза-монет значение должно быть больше 0, пороги лиг не повторяются)',
  bad_image: 'Неверная картинка',
  image_too_big: 'Картинка слишком большая',
  in_use: 'Уже используется, удалить нельзя',
  forbidden: 'Нет доступа',
  db_error: 'Ошибка сервера, попробуй ещё раз',
};
const errText = (e) => ERRORS[e.message] || `Ошибка: ${e.message}`;

const inputCls =
  'w-full rounded-lg bg-slate-900 px-2.5 py-2 text-sm text-white outline-none ring-1 ring-slate-700 focus:ring-yellow-400/70';
const num = (v) => (v === '' || v === null || v === undefined ? NaN : Number(String(v).replace(',', '.')));

// Подписи и подсказки для чисел из /admin/settings (границы проверяет сервер).
const SETTING_GROUPS = [
  ['Колесо', [
    ['wheel_price', 'Цена платного спина'],
    ['wheel_max_paid', 'Платных спинов в день'],
  ]],
  ['Кражи', [
    ['steal_price', 'Цена заряда кражи'],
    ['steal_max_charges', 'Максимум зарядов у игрока'],
    ['steal_pct_min', 'Крадётся от, % кошелька'],
    ['steal_pct_max', 'Крадётся до, % кошелька'],
    ['steal_cap', 'Потолок одной кражи (0 — без потолка)'],
    ['steal_min_balance', 'У жертвы в кошельке больше, чем'],
    ['steal_newbie_hours', 'Защита новичков, часов (0 — нет)'],
    ['steal_victim_cap', 'Краж у одного игрока в сутки (0 — без лимита)'],
  ]],
  ['Бусты и привилегии', [
    ['tap_boost_mult', 'Буст удара: множитель (×)'],
    ['vip_wheel_discount', 'VIP: скидка на платный спин, %'],
  ]],
  ['Прокачка удара', [
    ['tap_upgrade_base', 'Цена первого улучшения'],
    ['tap_upgrade_growth', 'Рост цены за уровень (×)'],
    ['tap_max_level', 'Максимальный уровень'],
  ]],
  ['Локации', [
    ['locations_cap_hours', 'Доход копится, часов'],
    ['location_price_growth', 'Рост цены за уровень (×)'],
    ['location_income_growth', 'Рост дохода за уровень (×)'],
  ]],
];

// Картинка из файла → base64. Большие уменьшаем до 512 px, чтобы влезть в лимит сервера.
async function fileToImage(file) {
  const readAsDataUrl = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
  if (file.type === 'image/gif' && file.size < 600 * 1024) {
    return { mime: 'image/gif', data: (await readAsDataUrl(file)).split(',')[1] };
  }
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  let url = canvas.toDataURL('image/png');
  if (url.length > 900 * 1024) url = canvas.toDataURL('image/webp', 0.85);
  return { mime: url.slice(5, url.indexOf(';')), data: url.split(',')[1] };
}

function ImagePicker({ value, onChange, onError }) {
  const [busy, setBusy] = useState(false);
  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const { mime, data } = await fileToImage(file);
      onChange((await adminUploadImage(mime, data)).url);
    } catch (err) {
      onError(errText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="admin-img">
      {value ? <img src={assetUrl(value)} alt="" /> : <span className="admin-img-empty">нет</span>}
      <label className="admin-img-btn">
        {busy ? '…' : 'Загрузить'}
        <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={pick} disabled={busy} />
      </label>
      {value && <button type="button" className="admin-img-btn" onClick={() => onChange(null)}>Убрать</button>}
    </span>
  );
}

function Section({ title, children }) {
  return (
    <details className="admin-section">
      <summary>{title}</summary>
      <div className="mt-3 space-y-3">{children}</div>
    </details>
  );
}

const STREAK_KEYS = ['coins', 'spins', 'steals', 'boost', 'vip'];
const NAV_LABELS = [
  ['game', 'Играть'], ['gift', 'Подарить'], ['bets', 'Прогнозы'], ['wheel', 'Колесо'],
  ['locations', 'Локации'], ['bank', 'Банк'], ['admin', 'Админ'],
];

const KIND_LABELS = { coins: 'Монеты', free_bet: 'Фрибет', steal: 'Кража' };

function PrizeRow({ prize, totalWeight, onSaved, onMsg }) {
  const [d, setD] = useState({ ...prize, image: prize.image_url });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setD((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const chance = d.active && totalWeight ? ((num(d.weight) / totalWeight) * 100).toFixed(1) : '0';
  const save = async () => {
    setBusy(true);
    const body = {
      label: String(d.label).trim(), kind: d.kind, value: d.kind === 'steal' ? 0 : num(d.value),
      weight: num(d.weight), active: d.active, imageUrl: d.image ?? null,
    };
    try {
      if (prize.id) await adminUpdatePrize(prize.id, body);
      else await adminCreatePrize(body);
      onMsg(true, `Приз «${body.label}» сохранён`);
      onSaved();
    } catch (e) {
      onMsg(false, errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`admin-card ${d.active ? '' : 'opacity-60'}`}>
      <div className="grid grid-cols-2 gap-2">
        <label className="admin-field">Надпись<input className={inputCls} value={d.label} maxLength={40} onChange={set('label')} /></label>
        <label className="admin-field">Тип
          <select className={inputCls} value={d.kind} onChange={set('kind')}>
            {Object.entries(KIND_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="admin-field">{d.kind === 'free_bet' ? 'Сумма фрибета' : 'Монет'}
          <input className={inputCls} inputMode="numeric" value={d.kind === 'steal' ? '—' : d.value}
            disabled={d.kind === 'steal'} onChange={set('value')} />
        </label>
        <label className="admin-field">Вес (шанс {chance}%)
          <input className={inputCls} inputMode="numeric" value={d.weight} onChange={set('weight')} />
        </label>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <ImagePicker value={d.image} onChange={(url) => setD((x) => ({ ...x, image: url }))} onError={(t) => onMsg(false, t)} />
        <label className="flex items-center gap-1.5 text-xs text-slate-300">
          <input type="checkbox" checked={d.active} onChange={set('active')} /> на колесе
        </label>
        <button type="button" disabled={busy} onClick={save} className="admin-save">Сохранить</button>
      </div>
    </div>
  );
}

function LocationRow({ loc, onSaved, onMsg }) {
  const [d, setD] = useState({
    name: loc.name, price: loc.base_price, income: loc.base_income, maxLevel: loc.max_level,
    active: loc.active, image: loc.image_url,
  });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setD((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const save = async () => {
    setBusy(true);
    const body = {
      name: String(d.name).trim(), basePrice: num(d.price), baseIncome: num(d.income),
      maxLevel: num(d.maxLevel), active: d.active, imageUrl: d.image ?? null,
    };
    try {
      if (loc.id) await adminUpdateLocation(loc.id, body);
      else await adminCreateLocation(body);
      onMsg(true, `Локация «${body.name}» сохранена`);
      onSaved();
    } catch (e) {
      onMsg(false, e.status === 400 && !ERRORS[e.message] ? 'Проверь поля: числа целые и больше нуля' : errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`admin-card ${d.active ? '' : 'opacity-60'}`}>
      <div className="grid grid-cols-2 gap-2">
        <label className="admin-field">Название<input className={inputCls} value={d.name} maxLength={40} onChange={set('name')} /></label>
        <label className="admin-field">Макс. уровень<input className={inputCls} inputMode="numeric" value={d.maxLevel} onChange={set('maxLevel')} /></label>
        <label className="admin-field">Цена покупки<input className={inputCls} inputMode="numeric" value={d.price} onChange={set('price')} /></label>
        <label className="admin-field">Доход в час (ур. 1)<input className={inputCls} inputMode="numeric" value={d.income} onChange={set('income')} /></label>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <ImagePicker value={d.image} onChange={(url) => setD((x) => ({ ...x, image: url }))} onError={(t) => onMsg(false, t)} />
        <label className="flex items-center gap-1.5 text-xs text-slate-300">
          <input type="checkbox" checked={d.active} onChange={set('active')} /> продаётся
        </label>
        <button type="button" disabled={busy} onClick={save} className="admin-save">Сохранить</button>
      </div>
    </div>
  );
}

function LeagueRow({ league, onSaved, onMsg }) {
  const [d, setD] = useState({
    name: league.name, minPeak: league.min_peak, r1: league.reward_1, r2: league.reward_2, r3: league.reward_3,
  });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setD((x) => ({ ...x, [k]: e.target.value }));
  const run = async (fn, okText) => {
    setBusy(true);
    try {
      await fn();
      onMsg(true, okText);
      onSaved();
    } catch (e) {
      onMsg(false, e.status === 400 && !ERRORS[e.message] ? 'Проверь поля: целые числа от 0' : errText(e));
    } finally {
      setBusy(false);
    }
  };
  const body = () => ({ name: String(d.name).trim(), minPeak: num(d.minPeak), rewards: [num(d.r1), num(d.r2), num(d.r3)] });
  return (
    <div className="admin-card">
      <div className="grid grid-cols-2 gap-2">
        <label className="admin-field">Название<input className={inputCls} value={d.name} maxLength={40} onChange={set('name')} /></label>
        <label className="admin-field">Порог (макс. баланс)<input className={inputCls} inputMode="numeric" value={d.minPeak} onChange={set('minPeak')} /></label>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2">
        {['r1', 'r2', 'r3'].map((k, i) => (
          <label key={k} className="admin-field">Награда {i + 1} место<input className={inputCls} inputMode="numeric" value={d[k]} onChange={set(k)} /></label>
        ))}
      </div>
      <div className="mt-2 flex justify-end gap-2">
        {league.id && (
          <button type="button" disabled={busy} className="admin-img-btn"
            onClick={() => run(() => adminDeleteLeague(league.id), `Лига «${league.name}» удалена`)}>
            Удалить
          </button>
        )}
        <button type="button" disabled={busy} className="admin-save"
          onClick={() => run(() => (league.id ? adminUpdateLeague(league.id, body()) : adminCreateLeague(body())),
            `Лига «${d.name}» сохранена`)}>
          Сохранить
        </button>
      </div>
    </div>
  );
}

export default function AdminGame({ active }) {
  const [game, setGame] = useState(null);
  const [draft, setDraft] = useState({});
  const [streak, setStreak] = useState([]);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0); // меняется после загрузки: строки берут свежие данные
  const [adding, setAdding] = useState({ prize: false, location: false, league: false });
  const [navIcons, setNavIcons] = useState({});

  const load = useCallback(async () => {
    try {
      const g = await adminGetGame();
      setGame(g);
      setDraft(Object.fromEntries(SETTING_GROUPS.flatMap(([, items]) => items).map(([k]) => [k, String(g.settings[k])])));
      setStreak(g.settings.streak_rewards.map((r) => Object.fromEntries(STREAK_KEYS.map((k) => [k, r[k] ?? 0]))));
      setNavIcons(g.settings.nav_icons ?? {});
      setVersion((v) => v + 1);
      setAdding({ prize: false, location: false, league: false });
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    }
  }, []);

  useEffect(() => {
    if (active) load();
  }, [active, load]);

  const onMsg = (ok, text) => setMsg({ ok, text });

  const save = async (values, okText) => {
    setBusy(true);
    setMsg(null);
    try {
      await adminSaveSettings(values);
      setMsg({ ok: true, text: okText });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: e.message === 'bad_setting' ? 'Одно из значений вне допустимых границ' : errText(e) });
    } finally {
      setBusy(false);
    }
  };

  if (!game) return <p className="mt-6 text-sm text-slate-500">{msg?.text ?? 'Загрузка настроек игры…'}</p>;

  const totalWeight = game.prizes.filter((p) => p.active).reduce((s, p) => s + p.weight, 0);
  const setDay = (i, k, v) => setStreak((list) => list.map((r, j) => (j === i ? { ...r, [k]: v } : r)));

  return (
    <div className="mt-6 space-y-3">
      <p className="text-sm font-semibold text-slate-300">Настройки игры</p>
      {msg && <p className={`text-sm ${msg.ok ? 'text-emerald-300' : 'text-red-400'}`}>{msg.text}</p>}

      <Section title="Оформление: логотип и монета">
        <div className="admin-card space-y-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm">Логотип (вместо «PM»)</span>
            <ImagePicker value={game.settings.logo_url} onError={(t) => onMsg(false, t)}
              onChange={(url) => save({ logo_url: url }, url ? 'Логотип обновлён' : 'Логотип сброшен')} />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm">Монета (кнопка тапа и иконки)</span>
            <ImagePicker value={game.settings.coin_url} onError={(t) => onMsg(false, t)}
              onChange={(url) => save({ coin_url: url }, url ? 'Монета обновлена' : 'Монета сброшена')} />
          </div>
          <p className="text-xs text-slate-500">PNG/JPG/WebP/GIF. Картинка уменьшится до 512 px. Для локаций и призов — в их разделах.</p>
        </div>
      </Section>

      <Section title="Иконки нижнего меню">
        <div className="admin-card space-y-2">
          {NAV_LABELS.map(([id, label]) => (
            <div key={id} className="flex items-center justify-between gap-2">
              <span className="text-sm">{label}</span>
              <ImagePicker value={navIcons[id] ?? null} onError={(t) => onMsg(false, t)}
                onChange={(url) => save({ nav_icons: { ...navIcons, [id]: url } }, url ? `Иконка «${label}» обновлена` : `Иконка «${label}» сброшена`)} />
            </div>
          ))}
          <p className="text-xs text-slate-500">Квадратная картинка с прозрачным фоном смотрится лучше всего. «Убрать» вернёт стандартную иконку.</p>
        </div>
      </Section>

      <Section title="Колесо: призы и шансы">
        {game.prizes.map((p) => (
          <PrizeRow key={`${p.id}-${version}`} prize={p} totalWeight={totalWeight} onSaved={load} onMsg={onMsg} />
        ))}
        {adding.prize ? (
          <PrizeRow prize={{ id: null, label: '', kind: 'coins', value: 100, weight: 5, active: true, image_url: null }}
            totalWeight={totalWeight + 5} onSaved={load} onMsg={onMsg} />
        ) : (
          <button type="button" className="text-sm text-yellow-400" onClick={() => setAdding((a) => ({ ...a, prize: true }))}>
            + добавить приз
          </button>
        )}
        <p className="text-xs text-slate-500">
          Шанс = вес приза / сумма весов включённых призов. Удалять призы нельзя (на них ссылается история) — снимай галочку.
        </p>
      </Section>

      <Section title="Цены и параметры">
        <div className="admin-card space-y-3">
          {SETTING_GROUPS.map(([group, items]) => (
            <div key={group}>
              <p className="text-xs font-semibold text-yellow-300">{group}</p>
              <div className="mt-1 grid grid-cols-2 gap-2">
                {items.map(([k, label]) => (
                  <label key={k} className="admin-field">{label}
                    <input className={inputCls} inputMode="decimal" value={draft[k] ?? ''}
                      onChange={(e) => setDraft((x) => ({ ...x, [k]: e.target.value }))} />
                  </label>
                ))}
              </div>
            </div>
          ))}
          <button type="button" disabled={busy} className="admin-save w-full"
            onClick={() => save(Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, num(v)])), 'Цены сохранены')}>
            Сохранить цены
          </button>
        </div>
      </Section>

      <Section title="Награды стрика">
        <div className="admin-card space-y-2">
          <div className="admin-streak-grid text-xs text-slate-400">
            <span>День</span><span>Монеты</span><span>Спины</span><span>Кражи</span><span>Буст, мин</span><span>VIP, ч</span>
          </div>
          {streak.map((r, i) => (
            <div key={i} className="admin-streak-grid items-center">
              <span className="text-sm font-bold">{i + 1}</span>
              {STREAK_KEYS.map((k) => (
                <input key={k} className={inputCls} inputMode="numeric" value={r[k]}
                  onChange={(e) => setDay(i, k, e.target.value.replace(/\D/g, ''))} />
              ))}
            </div>
          ))}
          <div className="flex gap-3 text-sm">
            {streak.length < 14 && (
              <button type="button" className="text-yellow-400"
                onClick={() => setStreak((l) => [...l, Object.fromEntries(STREAK_KEYS.map((k) => [k, 0]))])}>
                + день
              </button>
            )}
            {streak.length > 1 && (
              <button type="button" className="text-slate-400" onClick={() => setStreak((l) => l.slice(0, -1))}>− день</button>
            )}
          </div>
          <button type="button" disabled={busy} className="admin-save w-full"
            onClick={() => save({ streak_rewards: streak.map((r) => Object.fromEntries(STREAK_KEYS.map((k) => [k, num(r[k]) || 0]))) },
              'Награды стрика сохранены')}>
            Сохранить награды
          </button>
          <p className="text-xs text-slate-500">
            Буст — монет за тап больше в {game.settings.tap_boost_mult} раза на указанные минуты. VIP — скидка
            {' '}{game.settings.vip_wheel_discount}% на платный спин и корона в лидерборде на указанные часы. Повторная награда продлевает срок.
            После последнего дня цикл начинается заново. Пропустил день — стрик с первого дня.
          </p>
        </div>
      </Section>

      <Section title="Локации: цены, доход, картинки">
        {game.locations.map((l) => <LocationRow key={`${l.id}-${version}`} loc={l} onSaved={load} onMsg={onMsg} />)}
        {adding.location ? (
          <LocationRow loc={{ id: null, name: '', base_price: 1000, base_income: 50, max_level: 25, active: true, image_url: null }}
            onSaved={load} onMsg={onMsg} />
        ) : (
          <button type="button" className="text-sm text-yellow-400" onClick={() => setAdding((a) => ({ ...a, location: true }))}>
            + добавить локацию
          </button>
        )}
        <p className="text-xs text-slate-500">
          Цена следующего уровня и доход растут по множителям из «Цены и параметры». На карте показываются первые 4 локации.
        </p>
      </Section>

      <Section title="Лиги и недельные награды">
        {game.leagues.map((l) => <LeagueRow key={`${l.id}-${version}`} league={l} onSaved={load} onMsg={onMsg} />)}
        {adding.league ? (
          <LeagueRow league={{ id: null, name: '', min_peak: '', reward_1: 0, reward_2: 0, reward_3: 0 }} onSaved={load} onMsg={onMsg} />
        ) : (
          <button type="button" className="text-sm text-yellow-400" onClick={() => setAdding((a) => ({ ...a, league: true }))}>
            + добавить лигу
          </button>
        )}
        <p className="text-xs text-slate-500">
          Игрок попадает в лигу, когда его максимальный баланс за всё время достигает порога. Нужна лига с порогом 0.
        </p>
      </Section>
    </div>
  );
}
