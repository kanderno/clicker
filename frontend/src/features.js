// Ставки (Прогнозы) и переводы (Подарить) выключены по просьбе заказчика, вместо них — «Экология».
// Код этих функций не удалён: чтобы вернуть, поставь true здесь И FEATURE_BETS=1 / FEATURE_TRANSFERS=1
// на сервере (backend/.env или переменные Bothost). Полная копия до изменений — ветка git backup/bets-transfers.
export const FEATURES = {
  bets: false,
  transfers: false,
};
