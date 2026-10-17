// ntfy (https://ntfy.sh, open source, can be hosted at home): one JSON post
// to the server, on the topic the human's phone listens to. The topic is as
// good as a password (whoever knows it reads the messages), so the server, the
// topic and the optional access token live in the service's private
// credentials file ("ntfy": {"server", "topic", "token"}), never in agents.conf.
const loopback = (host) => ['localhost', '127.0.0.1', '[::1]'].includes(host);

export function ntfyTarget(value) {
  let url;
  try { url = new URL(value?.server); } catch { return null; }
  if (url.username || url.password || !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback(url.hostname)))) return null;
  if (typeof value.topic !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.topic)) return null;
  if (value.token !== undefined && (typeof value.token !== 'string' || !/^[A-Za-z0-9_.-]{8,200}$/.test(value.token))) return null;
  return { server: `${url.origin}${url.pathname.replace(/\/+$/, '')}`, topic: value.topic, token: value.token };
}

export function ntfyAdapter({ credentials, transport = fetch, timeoutMs = 10000 }) {
  const target = () => { try { return ntfyTarget(credentials()); } catch { return null; } };
  return {
    name: 'ntfy',
    ready: () => (target() ? null : 'no_credentials'),
    async send(message, { signal } = {}) {
      const to = target();
      if (!to) throw new Error('no credentials');
      // JSON publishing: a title with accents cannot go in an HTTP header.
      const body = { topic: to.topic, title: message.title, message: message.body, priority: message.urgent ? 5 : 3, tags: [message.urgent ? 'warning' : 'bell'] };
      if (message.url) body.click = message.url;
      let response;
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
