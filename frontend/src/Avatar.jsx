import { useState } from 'react';
import WebApp from '@twa-dev/sdk';

// Имя игрока для подписи: имя из Telegram, иначе ник.
export const displayName = (u) => u?.firstName || u?.first_name || (u?.username ? `@${u.username}` : 'Игрок');

// Аватарка из Telegram; если фото нет или не загрузилось — первая буква имени.
export default function Avatar({ user, className = '' }) {
  const [broken, setBroken] = useState(false);
  const photo = user?.photoUrl || user?.photo_url;
  const initial = Array.from(displayName(user).replace(/^@/, ''))[0]?.toLocaleUpperCase('ru-RU') || '?';
  if (photo && !broken) {
    return (
      <img src={photo} alt="" className={`avatar ${className}`} loading="lazy" referrerPolicy="no-referrer"
        onError={() => setBroken(true)} />
    );
  }
  return <span className={`avatar avatar-fallback ${className}`} aria-hidden="true">{initial}</span>;
}

// Открыть профиль игрока в Telegram (нужен @ник: по одному id ссылку не построить).
export function openProfile(username) {
  if (!username) return false;
  const url = `https://t.me/${encodeURIComponent(username)}`;
  try {
    WebApp.openTelegramLink(url);
  } catch {
    window.open(url, '_blank', 'noopener');
  }
  return true;
}
