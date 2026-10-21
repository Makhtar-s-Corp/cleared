// The session screen (session.png): a stub until lane 9 (v2-j1-session-screen)
// fills it. That lane edits only this file, its messages, its fixture and
// its tests (plan, section 10).
import { esc } from '../html.ts';
import type { ScreenContext } from '../screen.ts';

export function mount(root: HTMLElement, context: ScreenContext): () => void {
  root.innerHTML = `<div class="stub"><h1>${esc(context.t('session_title'))}</h1><p class="muted">${esc(context.t('session_stub'))}</p></div>`;
  return () => {};
}
