// The page's requests: same origin only, the session cookie, and on a write
// the anti-forgery token. Every address is a path of this app; the page
// runs under default-src 'self', so nothing else could load anyway.
import { ApiError, type Me, type ScreenContext } from './screen.ts';

export async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', ...init });
  if (!response.ok) throw new ApiError(response.status, `${url}: ${response.status}`);
  return response.status === 204 ? (undefined as T) : await response.json() as T;
}

export function serviceApi(me: Pick<Me, 'csrf'>): ScreenContext['api'] {
  return (path, init = {}) => {
    const write = init.method === 'POST';
    const headers: Record<string, string> = { accept: 'application/json' };
    if (write) {
      headers['x-csrf-token'] = me.csrf;
      headers['content-type'] = 'application/json';
    }
    return json(`/api/service${path}`, { method: init.method ?? 'GET', headers, body: write ? JSON.stringify(init.body ?? null) : null });
  };
}
