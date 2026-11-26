// Ставки (Прогнозы) и переводы (Подарить) снова включены по просьбе заказчика, «Экология» выключена.
// Код экологии не удалён: чтобы вернуть, поставь eco: true здесь И FEATURE_ECO=1 на сервере
// (backend/.env или переменные Bothost). Копия версии с экологией — ветка git backup/eco (тег eco-v1).
export const FEATURES = {
  bets: true,
  transfers: true,
  eco: false,
};
