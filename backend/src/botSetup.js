import { BOT_DESCRIPTION, BOT_SHORT_DESCRIPTION, COMMANDS, isHttpsUrl } from './bot.js';

/**
 * Настраивает бота через Bot API: команды, описания, кнопка меню «Играть».
 * Если передан apiBaseUrl, включает вебхук (для продакшена); иначе вебхук не трогает.
 */
export async function setupBot(api, { webAppUrl, apiBaseUrl = null, webhookSecret = null }) {
  if (!isHttpsUrl(webAppUrl)) throw new Error('WEBAPP_URL должен быть https-ссылкой (Telegram не открывает http)');

  const done = [];
  await api.call('setMyCommands', { commands: COMMANDS });
  done.push('команды /start /play /help');
  await api.call('setMyDescription', { description: BOT_DESCRIPTION });
  await api.call('setMyShortDescription', { short_description: BOT_SHORT_DESCRIPTION });
  done.push('описание бота');
  await api.call('setChatMenuButton', {
    menu_button: { type: 'web_app', text: 'Играть', web_app: { url: webAppUrl } },
  });
  done.push('кнопка меню «Играть»');

  if (apiBaseUrl) {
    if (!isHttpsUrl(apiBaseUrl)) throw new Error('Адрес API для вебхука должен быть https-ссылкой');
    if (!webhookSecret) throw new Error('Нужен TELEGRAM_WEBHOOK_SECRET для вебхука');
    await api.call('setWebhook', {
      url: `${apiBaseUrl.replace(/\/+$/, '')}/telegram/webhook`,
      secret_token: webhookSecret,
      allowed_updates: ['message'],
      drop_pending_updates: true,
    });
    done.push('вебхук');
  }
  return done;
}

/** Меняет/добавляет строку KEY=value в тексте .env, сохраняя остальные строки и переносы (Windows: CRLF). */
export function upsertEnvLine(text, key, value) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const re = new RegExp(`^\\s*${key}\\s*=`);
  const i = lines.findIndex((l) => re.test(l));
  const line = `${key}=${value}`;
  if (i >= 0) {
    lines[i] = line;
  } else if (lines.length && lines[lines.length - 1] === '') {
    lines.splice(lines.length - 1, 0, line); // файл кончался переводом строки
  } else {
    lines.push(line);
  }
  return lines.join(eol);
}
