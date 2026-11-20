import crypto from 'node:crypto';

// «Экология»: игроки присылают фото/видео своей помощи природе, проверяющий одобряет и даёт монеты.
export const ECO_BUCKET = 'eco-reports';
export const ECO_MAX_FILES = 5;
export const ECO_MAX_BYTES = 30 * 1024 * 1024; // как file_size_limit бакета в 019_eco.sql

// Разрешённые типы файлов и расширение, под которым файл лежит в хранилище.
export const ECO_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};
const EXT_MIME = Object.fromEntries(Object.entries(ECO_MIME).map(([mime, ext]) => [ext, mime]));

/** Новое имя файла игрока: "<uid>/<uuid>.<ext>". Имя придумывает сервер, а не клиент. */
export function ecoFilePath(uid, mime) {
  const ext = ECO_MIME[mime];
  if (!ext || !Number.isSafeInteger(uid) || uid < 1) return null;
  return `${uid}/${crypto.randomUUID()}.${ext}`;
}

/**
 * Проверка списка файлов заявки: только файлы этого игрока, выданные сервером, без повторов.
 * Возвращает [{ path, mime }] (mime берётся из расширения) или null.
 */
export function cleanEcoMedia(uid, list) {
  if (!Array.isArray(list) || list.length < 1 || list.length > ECO_MAX_FILES) return null;
  const re = new RegExp(`^${uid}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.([a-z0-9]{3,4})$`);
  const out = [];
  for (const item of list) {
    const m = re.exec(typeof item?.path === 'string' ? item.path : '');
    const mime = m && EXT_MIME[m[1]];
    if (!mime || out.some((x) => x.path === item.path)) return null;
    out.push({ path: item.path, mime });
  }
  return out;
}

/** Строка заявки из базы -> ответ клиенту. urls — временные ссылки на файлы по path. */
export function ecoReportView(row, urls, user) {
  return {
    id: row.id,
    description: row.description,
    status: row.status,
    reward: Number(row.reward),
    reviewer: row.reviewer_name,
    comment: row.review_comment,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    media: (row.media ?? []).map((f) => ({ mime: f.mime, url: urls.get(f.path) ?? null })),
    ...(user !== undefined ? { user } : {}),
  };
}
