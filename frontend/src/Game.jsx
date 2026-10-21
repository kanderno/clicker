import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import WebApp from '@twa-dev/sdk';
import { login, sendTaps } from './api.js';
import Coin from './Coin.jsx';

const FLUSH_MS = 7000;      // раз в 7 секунд отправляем накопленные тапы
const MAX_CPS = 12;         // на клиенте чуть ниже серверного лимита (15), чтобы не терять тапы
const MIN_GAP = 1000 / MAX_CPS;
const MAX_FLOATERS = 12;

const fmt = (n) => n.toLocaleString('ru-RU');

// balance: подтверждённый сервером баланс (хранится в App). pending: тапы, ещё не отправленные.
// Показываем balance + pending только для отклика интерфейса; истина всегда на сервере.
const Game = forwardRef(function Game({ user, balance, onBalance }, ref) {
  const [pending, setPending] = useState(0);
  const [syncError, setSyncError] = useState(null); // код ошибки или null
  const [floaters, setFloaters] = useState([]);

  const pendingRef = useRef(0);
  const flushPromise = useRef(null);
  const lastTapAt = useRef(0);
  const floaterId = useRef(0);
  const areaRef = useRef(null);
  const playerName = user.first_name || user.username || 'Игрок';
  const playerInitial = Array.from(playerName)[0].toLocaleUpperCase('ru-RU');

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

  // Родитель вызывает flush перед переходом в банк, чтобы баланс на сервере был актуальным.
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

  const onTap = (e) => {
    const now = performance.now();
    if (now - lastTapAt.current < MIN_GAP) return;
    lastTapAt.current = now;

    pendingRef.current += 1;
    setPending(pendingRef.current);

    try {
      WebApp.HapticFeedback.impactOccurred('light');
    } catch {
      /* вне Telegram вибрации нет */
    }

    const rect = areaRef.current.getBoundingClientRect();
    const id = ++floaterId.current;
    const item = { id, x: e.clientX - rect.left, y: e.clientY - rect.top };
    setFloaters((f) => [...f.slice(-(MAX_FLOATERS - 1)), item]);
    setTimeout(() => setFloaters((f) => f.filter((i) => i.id !== id)), 700);
  };

  return (
    <div className="game-screen">
      <header className="game-header">
        <div className="brand-lockup">
          <span className="app-mark" aria-hidden="true">✦</span>
          <span>
            <span className="brand-title">ТАП-КЛУБ</span>
            <span className="brand-caption">СОБИРАЙ МОНЕТЫ</span>
          </span>
        </div>
        <span className="player-avatar" title={playerName}>{playerInitial}</span>
      </header>

      <section className="balance-card" aria-label="Текущий баланс">
        <div className="balance-topline">
          <p className="balance-label">ТВОЙ БАЛАНС</p>
          <span className="balance-tag"><span /> В ИГРЕ</span>
        </div>
        <p className="balance-value">
          <Coin className="balance-coin" />
          <span className="tabular-nums">{fmt(balance + pending)}</span>
        </p>
        <p className={`sync-status ${syncError ? 'has-error' : pending > 0 ? 'is-pending' : ''}`}>
          <span className="sync-dot" />
          {syncError
            ? `Не сохранилось (${syncError}), повторим…`
            : pending > 0
              ? 'Синхронизируем баланс…'
              : 'Все монеты сохранены'}
        </p>
      </section>

      <div ref={areaRef} className="coin-stage">
        <span className="coin-orbit" aria-hidden="true" />
        <span className="coin-halo" aria-hidden="true" />
        <button
          type="button"
          onPointerDown={onTap}
          className="coin-tap-button"
          style={{ touchAction: 'manipulation' }}
          aria-label="Нажать на монету и заработать одну монету"
        >
          <Coin className="coin-art pointer-events-none" />
        </button>
        {floaters.map((f) => (
          <span
            key={f.id}
            className="float-up tap-floater"
            style={{ left: f.x, top: f.y }}
          >
            +1
          </span>
        ))}
      </div>

      <div className="tap-copy">
        <strong>Нажми на монету</strong>
        <span>Каждый тап приближает к награде</span>
      </div>

      <div className="game-note">
        <span className="note-spark" aria-hidden="true">✧</span>
        <span><strong>1 тап = 1 монета</strong><small>Баланс синхронизируется автоматически</small></span>
        <span className="note-arrow" aria-hidden="true">↗</span>
      </div>
    </div>
  );
});

export default Game;
