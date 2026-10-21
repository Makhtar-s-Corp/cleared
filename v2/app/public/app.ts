// The shell in the browser: who is signed in, the clock, the inbox count,
// the theme button, signing out, and the screen of this page (body's
// data-screen), mounted with its catalog over the shell's.
import { translator, type Catalog } from './i18n.ts';
import { ApiError, type Me, type Mount, type ScreenContext } from './screen.ts';

const INBOX_MS = 15_000;
const THEME_KEY = 'cleared-v2-theme';

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', ...init });
  if (!response.ok) throw new ApiError(response.status, `${url}: ${response.status}`);
  return response.status === 204 ? (undefined as T) : await response.json() as T;
}

function setTheme(button: HTMLButtonElement, theme: 'light' | 'dark', save: boolean): void {
  document.documentElement.dataset.theme = theme;
  button.setAttribute('aria-label', (theme === 'dark' ? button.dataset.light : button.dataset.dark) ?? '');
  button.setAttribute('aria-pressed', String(theme === 'dark'));
  if (!save) return;
  try { localStorage.setItem(THEME_KEY, theme); }
  catch { /* the choice lasts for this page only */ }
}

async function start(): Promise<void> {
  const screen = document.body.dataset.screen ?? 'tower';
  const root = document.getElementById('screen')!;
  let me: Me;
  try {
    me = await json<Me>('/api/me');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) location.assign('/login');
    return;
  }
  const [shell, own] = await Promise.all([json<Catalog>('/messages/shell.json'), json<Catalog>(`/messages/${screen}.json`)]);
  const t = translator({ ...shell, ...own });

  const clock = document.getElementById('clock') as HTMLTimeElement;
  const tick = () => {
    const now = new Date();
    clock.dateTime = now.toISOString();
    clock.textContent = now.toLocaleTimeString(me.language, { hour: '2-digit', minute: '2-digit', hour12: false });
  };
  tick();
  setInterval(tick, 1000);

  const theme = document.getElementById('theme') as HTMLButtonElement;
  setTheme(theme, document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light', false);
  theme.addEventListener('click', () => setTheme(theme, document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true));

  document.getElementById('sign-out')?.addEventListener('click', async () => {
    try { await json('/logout', { method: 'POST', headers: { 'x-csrf-token': me.csrf } }); }
    finally { location.assign('/login'); }
  });

  const api: ScreenContext['api'] = (path, init = {}) => {
    const write = init.method === 'POST';
    const headers: Record<string, string> = { accept: 'application/json' };
    if (write) {
      headers['x-csrf-token'] = me.csrf;
      headers['content-type'] = 'application/json';
    }
    return json(`/api/service${path}`, { method: init.method ?? 'GET', headers, body: write ? JSON.stringify(init.body ?? null) : null });
  };

  const count = document.getElementById('inbox-count')!;
  const recount = async () => {
    try {
      const items = await api<{ state: string }[]>('/inbox');
      const waiting = items.filter((item) => item.state === 'waiting').length;
      count.textContent = String(waiting);
      count.hidden = waiting === 0;
      count.setAttribute('aria-label', t('inbox_waiting', { n: waiting }));
    } catch {
      count.hidden = true;
    }
  };
  void recount();
  setInterval(() => void recount(), INBOX_MS);

  const module = await import(`./screens/${screen}.ts`) as { mount: Mount };
  module.mount(root, { t, me, api, now: () => new Date(), path: location.pathname, inboxChanged: () => void recount() });
}

void start();
