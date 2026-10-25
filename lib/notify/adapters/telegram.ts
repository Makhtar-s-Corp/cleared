// Telegram: a message from the human's own bot to the human's chat. The bot's
// token is in the address of every call, so the address is never said: an
// error names the status only. Token and chat live in the service's private
// credentials file ("telegram": {"bot_token", "chat_id"}). The API address can
// be changed only in the service's environment (CLEARED_NOTIFY_TELEGRAM_API),
// for a test double, never by the project's settings.
import type { Adapter, NotifyMessage, SendOptions, Transport } from '../contract.ts';

type TelegramCredentials = { bot_token?: unknown; chat_id?: unknown };
const api = () => process.env.CLEARED_NOTIFY_TELEGRAM_API || process.env.ORCH_NOTIFY_TELEGRAM_API || 'https://api.telegram.org';

export function telegramTarget(value: TelegramCredentials | null | undefined): { token: string; chat: string } | null {
  if (typeof value?.bot_token !== 'string' || !/^\d{3,20}:[A-Za-z0-9_-]{30,64}$/.test(value.bot_token)) return null;
  const chat = String(value.chat_id ?? '');
  if (!/^-?\d{1,20}$/.test(chat) && !/^@[A-Za-z0-9_]{5,32}$/.test(chat)) return null;
  return { token: value.bot_token, chat };
}

export function telegramAdapter({ credentials, transport = fetch, timeoutMs = 10000 }: { credentials: () => unknown; transport?: Transport; timeoutMs?: number }): Adapter {
  const target = () => { try { return telegramTarget(credentials() as TelegramCredentials | null | undefined); } catch { return null; } };
  return {
    name: 'telegram',
    ready: () => (target() ? null : 'no_credentials'),
    async send(message: NotifyMessage, { signal }: SendOptions = {}) {
      const to = target();
      if (!to) throw new Error('no credentials');
      // Plain text (no parse mode): nothing in it is read as markup.
      const text = [message.title, message.body, message.url].filter(Boolean).join('\n');
      let response: Awaited<ReturnType<Transport>>;
      try {
        response = await transport(`${api()}/bot${to.token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error',
          body: JSON.stringify({ chat_id: to.chat, text, link_preview_options: { is_disabled: true }, disable_notification: false }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
      } catch { throw new Error('telegram unreachable'); }
      if (!response.ok) throw new Error(`telegram refused (${response.status})`);
      return { delivered: 1 };
    },
  };
}
