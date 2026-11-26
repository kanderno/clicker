-- Этап 16: ставки и переводы снова включены, «Экология» выключена. Выполнить в Supabase -> SQL Editor.
--
-- Таблицы ставок и переводов не трогались, поэтому возвращать в базе почти нечего.
-- 019_eco.sql выключил призы «фрибет» на колесе — включаем их обратно.
-- Таблицу eco_reports и файлы в бакете eco-reports НЕ удаляем: экология может вернуться (FEATURE_ECO=1).

update prizes set active = true where kind = 'free_bet' and not active;

notify pgrst, 'reload schema';
