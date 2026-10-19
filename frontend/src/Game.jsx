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
    <div className="h-full flex flex-col items-center justify-between py-8 px-4 text-white">
      <div className="text-center">
        <p className="text-slate-400 text-sm">{user.first_name || user.username || 'Игрок'}</p>
        <p className="mt-2 flex items-center justify-center gap-3 text-5xl font-extrabold text-yellow-400 tabular-nums">
          <Coin className="w-11 h-11" />
          {fmt(balance + pending)}
        </p>
        <p className="mt-2 h-5 text-xs text-slate-500">
          {syncError
            ? `⚠️ не сохранилось (${syncError}), повторим…`
            : pending > 0
              ? 'синхронизация…'
              : 'сохранено ✓'}
        </p>
      </div>

      <div ref={areaRef} className="relative">
        <button
          onPointerDown={onTap}
          className="w-64 h-64 rounded-full transition-transform duration-75 active:scale-95
                     drop-shadow-[0_0_40px_rgba(251,191,36,0.45)]"
          style={{ touchAction: 'manipulation' }}
          aria-label="Тап"
        >
          <Coin className="w-full h-full pointer-events-none" />
        </button>
        {floaters.map((f) => (
          <span
            key={f.id}
            className="float-up absolute text-2xl font-bold text-yellow-200"
            style={{ left: f.x, top: f.y }}
          >
            +1
          </span>
        ))}
      </div>

      <p className="text-slate-500 text-xs">Тапай, монеты сохраняются на сервере</p>
    </div>
  );
});

export default Game;
