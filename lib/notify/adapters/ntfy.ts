// ntfy (https://ntfy.sh, open source, can be hosted at home): one JSON post
// to the server, on the topic the human's phone listens to. The topic is as
// good as a password (whoever knows it reads the messages), so the server, the
// topic and the optional access token live in the service's private
// credentials file ("ntfy": {"server", "topic", "token"}), never in agents.conf.
import type { Adapter, NotifyMessage, SendOptions, Transport } from '../contract.ts';

type NtfyCredentials = { server?: unknown; topic?: unknown; token?: unknown };
const loopback = (host: string) => ['localhost', '127.0.0.1', '[::1]'].includes(host);

export function ntfyTarget(value: NtfyCredentials | null | undefined): { server: string; topic: string; token: string | undefined } | null {
  let url: URL;
  try { url = new URL(value?.server as string); } catch { return null; }
  if (url.username || url.password || !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback(url.hostname)))) return null;
  if (typeof value!.topic !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value!.topic)) return null;
  if (value!.token !== undefined && (typeof value!.token !== 'string' || !/^[A-Za-z0-9_.-]{8,200}$/.test(value!.token))) return null;
  return { server: `${url.origin}${url.pathname.replace(/\/+$/, '')}`, topic: value!.topic, token: value!.token as string | undefined };
}

export function ntfyAdapter({ credentials, transport = fetch, timeoutMs = 10000 }: { credentials: () => unknown; transport?: Transport; timeoutMs?: number }): Adapter {
  const target = () => { try { return ntfyTarget(credentials() as NtfyCredentials | null | undefined); } catch { return null; } };
  return {
    name: 'ntfy',
    ready: () => (target() ? null : 'no_credentials'),
    async send(message: NotifyMessage, { signal }: SendOptions = {}) {
      const to = target();
      if (!to) throw new Error('no credentials');
      // JSON publishing: a title with accents cannot go in an HTTP header.
      const body: Record<string, unknown> = { topic: to.topic, title: message.title, message: message.body, priority: message.urgent ? 5 : 3, tags: [message.urgent ? 'warning' : 'bell'] };
      if (message.url) body.click = message.url;
      let response: Awaited<ReturnType<Transport>>;
      try {
        response = await transport(`${to.server}/`, { method: 'POST', body: JSON.stringify(body), redirect: 'error',
          headers: { 'content-type': 'application/json', ...(to.token ? { authorization: `Bearer ${to.token}` } : {}) }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
      } catch { throw new Error('ntfy unreachable'); }
      // Said by a code: never the server, the topic or what it answered.
      if (!response.ok) throw new Error(`ntfy refused (${response.status})`);
      return { delivered: 1 };
    },
  };
}
