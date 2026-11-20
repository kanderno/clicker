import { useCallback, useEffect, useRef, useState } from 'react';
import { getEco, sendEcoReport, uploadEcoFile } from './api.js';
import Coin from './Coin.jsx';

const fmt = (n) => Number(n).toLocaleString('ru-RU');
const MAX_FILES = 5;
const MAX_VIDEO_MB = 30;
const VIDEO_TYPES = { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };

const ERRORS = {
  bad_description: 'Опиши, что ты сделал (от 3 символов)',
  bad_media: 'Прикрепи хотя бы одно фото или видео',
  bad_file: 'Такой файл не подходит: нужны фото (jpg, png) или видео (mp4, mov)',
  eco_pending_limit: 'У тебя уже 3 заявки ждут проверки — дождись решения',
  eco_daily_limit: 'На сегодня лимит заявок исчерпан, приходи завтра',
  upload_failed: 'Не удалось загрузить файл, попробуй ещё раз',
  db_error: 'Ошибка сервера, попробуй ещё раз',
  http_413: `Файл слишком большой (видео до ${MAX_VIDEO_MB} МБ)`,
};
const errText = (e) => ERRORS[e.message] || ERRORS[`http_${e.status}`] || `Ошибка: ${e.message}`;

export const ECO_STATUS = {
  pending: { text: 'на проверке', cls: 'bg-amber-500/20 text-amber-300' },
  approved: { text: 'одобрено', cls: 'bg-emerald-500/20 text-emerald-300' },
  rejected: { text: 'отклонено', cls: 'bg-red-500/20 text-red-300' },
};

// Фото ужимаем в браузере до 1600 px (JPEG): быстрее грузится, а HEIC с iPhone становится JPEG.
async function shrinkImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * k);
    canvas.height = Math.round(img.naturalHeight * k);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob) throw new Error('bad_file');
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Файл из галереи -> { blob, mime } для загрузки, или ошибка с понятным кодом.
async function prepareFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const videoMime = file.type.startsWith('video/') ? file.type : VIDEO_TYPES[ext];
  if (videoMime) {
    if (!Object.values(VIDEO_TYPES).includes(videoMime)) throw new Error('bad_file');
    if (file.size > MAX_VIDEO_MB * 1024 * 1024) throw Object.assign(new Error('too_big'), { status: 413 });
    return { blob: file, mime: videoMime };
  }
  if (file.type.startsWith('image/') || ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'].includes(ext)) {
    try {
      return { blob: await shrinkImage(file), mime: 'image/jpeg' };
    } catch {
      throw new Error('bad_file');
    }
  }
  throw new Error('bad_file');
}

export function MediaGrid({ media, big = false }) {
  if (!media?.length) return null;
  return (
    <div className={`mt-2 grid gap-2 ${big ? 'grid-cols-1' : 'grid-cols-3'}`}>
      {media.map((m, i) => {
        if (!m.url) {
          return <div key={i} className="flex aspect-square items-center justify-center rounded-lg bg-slate-900 text-xs text-slate-500">файл</div>;
        }
        return m.mime.startsWith('video/') ? (
          <video key={i} src={m.url} controls playsInline preload="metadata"
            className={`w-full rounded-lg bg-black ${big ? 'max-h-96' : 'aspect-square object-cover'}`} />
        ) : (
          <a key={i} href={m.url} target="_blank" rel="noreferrer">
            <img src={m.url} alt="" loading="lazy"
              className={`w-full rounded-lg bg-slate-900 ${big ? 'max-h-96 object-contain' : 'aspect-square object-cover'}`} />
          </a>
        );
      })}
    </div>
  );
}

export default function Eco({ active }) {
  const [state, setState] = useState(null);
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]); // [{ file, preview, isVideo }]
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [msg, setMsg] = useState(null); // { ok, text }
  const inputRef = useRef(null);

  const load = useCallback(async () => {
    try {
      setState(await getEco());
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    }
  }, []);

  useEffect(() => {
    if (active) load();
  }, [active, load]);

  // Ссылки на превью освобождаем, когда файл убрали или экран закрылся.
  const filesRef = useRef(files);
  filesRef.current = files;
  useEffect(() => () => filesRef.current.forEach((f) => URL.revokeObjectURL(f.preview)), []);

  const pick = (e) => {
    const chosen = [...e.target.files].slice(0, MAX_FILES - files.length);
    e.target.value = '';
    setMsg(null);
    setFiles((list) => [
      ...list,
      ...chosen.map((file) => ({
        file,
        preview: URL.createObjectURL(file),
        isVideo: file.type.startsWith('video/') || /\.(mp4|mov|webm)$/i.test(file.name),
      })),
    ]);
  };

  const removeFile = (i) => {
    URL.revokeObjectURL(files[i].preview);
    setFiles((list) => list.filter((_, j) => j !== i));
  };

  const submit = async () => {
    if (text.trim().length < 3) return setMsg({ ok: false, text: ERRORS.bad_description });
    if (!files.length) return setMsg({ ok: false, text: ERRORS.bad_media });
    setBusy(true);
    setMsg(null);
    try {
      const media = [];
      for (let i = 0; i < files.length; i++) {
        setProgress(`Загружаю файл ${i + 1} из ${files.length}…`);
        const { blob, mime } = await prepareFile(files[i].file);
        media.push(await uploadEcoFile(blob, mime));
      }
      setProgress('Отправляю заявку…');
      await sendEcoReport(text.trim(), media);
      setText('');
      files.forEach((f) => URL.revokeObjectURL(f.preview));
      setFiles([]);
      setMsg({ ok: true, text: 'Заявка отправлена! Ждём проверку' });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  return (
    <div className="h-full overflow-y-auto px-4 py-6 text-white">
      <h1 className="text-center text-xl font-bold">Помоги экологии 🌱</h1>
      <p className="mt-2 text-center text-sm text-slate-400">
        Убрал мусор, посадил дерево, сдал вторсырьё? Сними фото или видео и получи монеты.
      </p>

      <div className="mt-5 grid grid-cols-2 gap-3">
        <div className="rounded-2xl bg-emerald-50 p-4 ring-1 ring-emerald-200">
          <p className="text-xs text-emerald-300/80">Награда за заявку</p>
          <p className="mt-1 flex items-center gap-1.5 text-2xl font-bold text-emerald-300 tabular-nums">
            <Coin className="h-6 w-6 shrink-0" />
            {state ? fmt(state.reward) : '…'}
          </p>
        </div>
        <div className="rounded-2xl bg-slate-800/70 p-4">
          <p className="text-xs text-slate-400">Проверяет</p>
          <p className="mt-1 text-base font-bold leading-tight text-yellow-300">✅ {state?.reviewer ?? '…'}</p>
        </div>
      </div>

      <div className="mt-5 space-y-3 rounded-2xl bg-slate-800/70 p-4">
        <p className="text-sm font-semibold text-slate-300">Новая заявка</p>
        <textarea
          value={text}
          maxLength={500}
          rows={3}
          onChange={(e) => setText(e.target.value)}
          placeholder="Что ты сделал и где? Например: убрал мусор на берегу реки у парка"
          className="w-full resize-none rounded-xl bg-slate-900 px-3 py-2.5 text-white outline-none ring-1 ring-slate-700 focus:ring-yellow-400/70"
        />

        {files.length > 0 && (
          <div className="grid grid-cols-3 gap-2">
            {files.map((f, i) => (
              <div key={f.preview} className="relative">
                {f.isVideo ? (
                  <video src={f.preview} muted playsInline className="aspect-square w-full rounded-lg bg-black object-cover" />
                ) : (
                  <img src={f.preview} alt="" className="aspect-square w-full rounded-lg bg-slate-900 object-cover" />
                )}
                {f.isVideo && <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1 text-[10px]">▶ видео</span>}
                <button type="button" disabled={busy} onClick={() => removeFile(i)} aria-label="Убрать файл"
                  className="absolute right-1 top-1 h-6 w-6 rounded-full bg-black/70 text-xs leading-6 text-white">✕</button>
              </div>
            ))}
          </div>
        )}

        <input ref={inputRef} type="file" accept="image/*,video/*" multiple hidden onChange={pick} />
        <button type="button" disabled={busy || files.length >= MAX_FILES} onClick={() => inputRef.current?.click()}
          className="w-full rounded-xl bg-slate-700/60 py-3 text-sm font-semibold text-slate-200 active:bg-slate-600 disabled:opacity-50">
          📷 Добавить фото или видео ({files.length}/{MAX_FILES})
        </button>

        <button type="button" disabled={busy} onClick={submit}
          className="w-full rounded-xl bg-yellow-400 py-3 font-semibold text-slate-950 active:bg-yellow-300 disabled:opacity-50">
          {busy ? progress || 'Отправляю…' : 'Отправить на проверку'}
        </button>
        <p className={`min-h-5 text-center text-sm ${msg?.ok ? 'text-emerald-300' : 'text-red-400'}`}>{msg?.text}</p>
      </div>

      <h2 className="mt-6 text-sm font-semibold text-slate-300">Мои заявки</h2>
      {state && !state.reports.length && <p className="mt-2 text-sm text-slate-500">Пока пусто — отправь первую!</p>}
      <div className="mt-2 space-y-3">
        {state?.reports.map((r) => {
          const st = ECO_STATUS[r.status];
          return (
            <div key={r.id} className="rounded-2xl bg-slate-800/70 p-3">
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 break-words text-sm">{r.description}</p>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${st.cls}`}>{st.text}</span>
              </div>
              <MediaGrid media={r.media} />
              {r.status === 'approved' && (
                <p className="mt-2 flex items-center gap-1 text-sm font-semibold text-emerald-300">
                  +<Coin className="h-4 w-4" />{fmt(r.reward)}
                  <span className="font-normal text-slate-400"> · проверил {r.reviewer}</span>
                </p>
              )}
              {r.status === 'rejected' && (
                <p className="mt-2 text-xs text-red-300">Отклонено{r.reviewer ? ` (${r.reviewer})` : ''}{r.comment ? `: ${r.comment}` : ''}</p>
              )}
              {r.status === 'approved' && r.comment && <p className="mt-1 text-xs text-slate-400">«{r.comment}»</p>}
            </div>
          );
        })}
      </div>

      <ul className="mt-5 space-y-1.5 pb-2 text-xs text-slate-400">
        <li>• На фото или видео должно быть видно, что ты сделал (до и после — ещё лучше).</li>
        <li>• До 5 файлов в заявке, видео до {MAX_VIDEO_MB} МБ.</li>
        <li>• Заявку проверяет {state?.reviewer ?? 'модератор'}. Монеты придут сразу после одобрения.</li>
        <li>• Чужие фото из интернета и повторы отклоняются.</li>
      </ul>
    </div>
  );
}
