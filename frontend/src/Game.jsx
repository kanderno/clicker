import { forwardRef, useCallback, useContext, useEffect, useImperativeHandle, useRef, useState } from 'react';
import WebApp from '@twa-dev/sdk';
import { assetUrl, buySteal, claimStreak, getGameState, login, sendTaps, stealFrom, upgradeTap } from './api.js';
import { AssetsContext } from './assets.js';
import Coin from './Coin.jsx';
import Avatar, { displayName } from './Avatar.jsx';
import Leaderboard, { MaskIcon } from './Leaderboard.jsx';
import Streak, { rewardParts } from './Streak.jsx';
import Sheet from './Sheet.jsx';

const FLUSH_MS = 7000;      // раз в 7 секунд отправляем накопленные тапы
const MAX_CPS = 12;         // на клиенте чуть ниже серверного лимита (15), чтобы не терять тапы
const MIN_GAP = 1000 / MAX_CPS;
const MAX_FLOATERS = 12;

const fmt = (n) => Number(n).toLocaleString('ru-RU');
// Время окончания буста/VIP: сегодня — только часы, иначе с датой.
const fmtTime = (iso) => {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return d.toLocaleString('ru-RU', sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};

const ERRORS = {
  insufficient_funds: 'Не хватает монет',
  max_level: 'Удар уже прокачан до максимума',
  already_claimed: 'Награда за сегодня уже получена',
  no_steal_charges: 'Нет зарядов кражи: выбей на колесе, получи за стрик или купи',
  self_steal: 'У себя украсть нельзя',
  victim_too_poor: 'У игрока слишком мало монет в кошельке',
  victim_protected: 'Игрока сейчас нельзя обокрасть: он новичок или его уже грабили сегодня',
  victim_not_found: 'Игрок не найден',
  steal_limit: 'Больше зарядов кражи держать нельзя',
  db_error: 'Ошибка сервера, попробуй ещё раз',
};
const errText = (e) => ERRORS[e.message] || 'Не получилось, попробуй ещё раз';

function haptic(kind) {
  try {
    if (kind === 'light') WebApp.HapticFeedback.impactOccurred('light');
    else WebApp.HapticFeedback.notificationOccurred(kind);
  } catch {
    /* вне Telegram вибрации нет */
  }
}

// balance: подтверждённый сервером баланс (хранится в App). pending: тапы, ещё не отправленные.
// Показываем balance + pending × сила удара только для отклика интерфейса; истина всегда на сервере.
const Game = forwardRef(function Game({ user, active, balance, onBalance, onGift, theme, onToggleTheme }, ref) {
  const { logoUrl } = useContext(AssetsContext);
  const [pending, setPending] = useState(0);
  const [syncError, setSyncError] = useState(null); // код ошибки или null
  const [floaters, setFloaters] = useState([]);
  const [state, setState] = useState(null); // /game/state: удар, стрик, кражи
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null); // { ok, text }
  const [stealTarget, setStealTarget] = useState(null);
  const [lbKey, setLbKey] = useState(0);

  const pendingRef = useRef(0);
  const flushPromise = useRef(null);
  const lastTapAt = useRef(0);
  const floaterId = useRef(0);
  const areaRef = useRef(null);
  const toastTimer = useRef(null);
  const power = state?.tap.power ?? 1;

  const showToast = useCallback((ok, text) => {
    clearTimeout(toastTimer.current);
    setToast({ ok, text });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const flush = useCallback(() => {
    if (flushPromise.current) return flushPromise.current;
    if (pendingRef.current === 0) return Promise.resolve();
    const count = pendingRef.current;
    const p = (async () => {
      try {
        const res = await sendTaps(count);
        pendingRef.current -= count; // тапы, сделанные во время запроса, остаются в очереди
        setPending(pendingRef.current);
        onBalance(res.balance);
        setSyncError(null);
      } catch (err) {
        setSyncError(err.message || 'unknown');
        if (err.status === 401) await login().catch(() => {}); // токен истёк: войдём заново
      } finally {
        flushPromise.current = null;
      }
    })();
    flushPromise.current = p;
    return p;
  }, [onBalance]);

  // Родитель вызывает flush перед переходом на другие вкладки, чтобы баланс на сервере был актуальным.
  useImperativeHandle(ref, () => ({ flush }), [flush]);

  useEffect(() => {
    const timer = setInterval(flush, FLUSH_MS);
    const onHide = () => document.visibilityState === 'hidden' && flush();
    document.addEventListener('visibilitychange', onHide);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onHide);
      flush();
    };
  }, [flush]);

  const loadState = useCallback(async () => {
    try {
      setState(await getGameState());
    } catch {
      /* панели просто не обновятся, кликер работает и без них */
    }
  }, []);

  useEffect(() => {
    if (active) loadState();
  }, [active, loadState]);

  // Когда буст или VIP заканчивается, перечитываем состояние: сила тапа вернётся к обычной.
  useEffect(() => {
    const ends = [state?.boost.until, state?.vip.until].filter(Boolean).map((t) => new Date(t).getTime() - Date.now());
    if (!ends.length) return undefined;
    const t = setTimeout(loadState, Math.max(1000, Math.min(...ends) + 500));
    return () => clearTimeout(t);
  }, [state, loadState]);

  const onTap = (e) => {
    const now = performance.now();
    if (now - lastTapAt.current < MIN_GAP) return;
    lastTapAt.current = now;

    pendingRef.current += 1;
    setPending(pendingRef.current);
    haptic('light');

    const rect = areaRef.current.getBoundingClientRect();
    const id = ++floaterId.current;
    const item = { id, x: e.clientX - rect.left, y: e.clientY - rect.top };
    setFloaters((f) => [...f.slice(-(MAX_FLOATERS - 1)), item]);
    setTimeout(() => setFloaters((f) => f.filter((i) => i.id !== id)), 700);
  };

  // Любое действие с монетами: сначала отправляем тапы, потом запрос, потом свежее состояние.
  const act = async (fn, okText) => {
    if (busy) return;
    setBusy(true);
    try {
      await flush();
      const r = await fn();
      if (r.balance !== undefined) onBalance(r.balance);
      haptic('success');
      showToast(true, okText(r));
      await loadState();
      setLbKey((k) => k + 1);
    } catch (e) {
      haptic('error');
      showToast(false, errText(e));
      loadState();
    } finally {
      setBusy(false);
    }
  };

  const doUpgrade = () => act(upgradeTap, (r) => `Удар прокачан до ${r.level} уровня: +${fmt(r.level)} за тап`);
  const doClaim = () =>
    act(claimStreak, (r) => `День ${r.day}: ${rewardParts(r).join(' + ') || 'награда получена'}`);
  const doBuySteal = () => act(buySteal, (r) => `Куплен заряд кражи. Всего: ${r.charges}`);

  const askSteal = (p) => {
    if (!state?.steals.charges) {
      showToast(false, ERRORS.no_steal_charges);
      return;
    }
    setStealTarget(p);
  };
  const doSteal = () => {
    const p = stealTarget;
    setStealTarget(null);
    act(() => stealFrom(p.id), (r) => `Украдено у ${displayName(p)}: +${fmt(r.stolen)}`);
  };

  const tap = state?.tap;
  const shown = balance + pending * power;

  return (
    <div className="game-screen">
      <header className="game-header">
        <div className="brand-lockup">
          {logoUrl
            ? <img src={assetUrl(logoUrl)} alt="" className="app-mark-img" />
            : <span className="app-mark" aria-hidden="true">PM</span>}
          <span>
            <span className="brand-title">PELMEN MARKET</span>
            <span className="brand-caption">ПЕЛЬМЕННЫЙ ЦЕХ</span>
          </span>
        </div>
        <span className="header-actions">
          <button type="button" className="theme-toggle" onClick={onToggleTheme}
            aria-label={theme === 'light' ? 'Включить тёмную тему' : 'Включить светлую тему'}>
            {theme === 'light' ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5Z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
              </svg>
            )}
          </button>
          <Avatar user={user} className="player-avatar" />
        </span>
      </header>

      <section className="balance-card" aria-label="Текущий баланс">
        <div className="balance-topline">
          <p className="balance-label">ТВОЙ БАЛАНС</p>
          <span className="balance-tag"><span /> В ИГРЕ</span>
        </div>
        <p className="balance-value">
          <Coin className="balance-coin" />
          <span className="tabular-nums">{fmt(shown)}</span>
        </p>
        <p className={`sync-status ${syncError ? 'has-error' : pending > 0 ? 'is-pending' : ''}`}>
          <span className="sync-dot" />
          {syncError
            ? `Не сохранилось (${syncError}), повторим…`
            : pending > 0
              ? 'Синхронизируем баланс…'
              : 'Все монеты сохранены'}
        </p>
        <div className="balance-stats">
          <span><small>За тап</small><b>+{fmt(power)}</b></span>
          <span><small>Кражи</small><b className={state?.steals.charges ? 'is-red' : ''}>{state?.steals.charges ?? 0}</b></span>
          <span><small>Бонус-спины</small><b>{state?.bonusSpins ?? 0}</b></span>
        </div>
        {(state?.boost.until || state?.vip.until) && (
          <div className="perks">
            {state.boost.until && (
              <span className="perk perk-boost">⚡ Буст x{state.boost.mult} до {fmtTime(state.boost.until)}</span>
            )}
            {state.vip.until && (
              <span className="perk perk-vip">👑 VIP до {fmtTime(state.vip.until)} · колесо −{state.vip.wheelDiscount}%</span>
            )}
          </div>
        )}
      </section>

      <div ref={areaRef} className="coin-stage">
        <span className="coin-halo" aria-hidden="true" />
        <button
          type="button"
          onPointerDown={onTap}
          className="coin-tap-button"
          style={{ touchAction: 'manipulation' }}
          aria-label={`Нажать на пелькоин и заработать ${power} монет`}
        >
          <Coin className="coin-art pointer-events-none" />
        </button>
        {floaters.map((f) => (
          <span key={f.id} className="float-up tap-floater" style={{ left: f.x, top: f.y }}>
            +{power}
          </span>
        ))}
      </div>

      {tap && (
        <button type="button" className="upgrade-tap" onClick={doUpgrade}
          disabled={busy || tap.upgradeCost === null || shown < tap.upgradeCost}>
          <span className="upgrade-tap-text">
            <b>Прокачать удар</b>
            <small>
              {tap.upgradeCost === null
                ? `Уровень ${tap.level} — максимум`
                : `Ур. ${tap.level} → ${tap.level + 1}: +${fmt(tap.level)} → +${fmt(tap.level + 1)} за тап`}
            </small>
          </span>
          {tap.upgradeCost !== null && (
            <span className="upgrade-tap-price"><Coin className="upgrade-coin" />{fmt(tap.upgradeCost)}</span>
          )}
        </button>
      )}

      <Streak streak={state?.streak} busy={busy} onClaim={doClaim} />

      <Leaderboard
        active={active}
        reloadKey={lbKey}
        steals={state?.steals}
        balance={shown}
        busy={busy}
        isAdmin={user.isAdmin}
        onGift={onGift}
        onSteal={askSteal}
        onBuySteal={doBuySteal}
        onNoNick={(p) => showToast(false, `У игрока ${displayName(p)} нет @ника — профиль не открыть`)}
      />

      <footer className="game-credits">
        <p>Concept: Ilyas Upushev, 2026</p>
        <p>Project leader: Ilyas, Alex, Michael</p>
        <p>Dev. Ilyas, Alex, Mansur</p>
        <p className="game-credits-copy">©️ 2026 Pelmen Coins Bot. All rights reserved. Not a p2p market!</p>
      </footer>

      {toast && <div className={`game-toast ${toast.ok ? 'is-ok' : 'is-error'}`} role="status">{toast.text}</div>}

      {stealTarget && (
        <Sheet onClose={() => setStealTarget(null)} className="text-center">
            <span className="sheet-icon"><MaskIcon /></span>
            <p className="mt-2 text-lg font-bold">Украсть у {displayName(stealTarget)}?</p>
            <p className="mt-1 text-sm text-slate-400">
              Потратится 1 заряд (осталось {state?.steals.charges ?? 0}). Сколько унесёшь — узнаешь после кражи.
            </p>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <button type="button" onClick={() => setStealTarget(null)}
                className="rounded-xl bg-slate-700 py-3 font-semibold active:bg-slate-600">
                Отмена
              </button>
              <button type="button" onClick={doSteal} className="sheet-danger rounded-xl py-3 font-semibold">
                Украсть
              </button>
            </div>
        </Sheet>
      )}
    </div>
  );
});

export default Game;
