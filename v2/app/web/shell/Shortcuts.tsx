// The keyboard in the page (docs/v2/ui-overhaul-plan.md, 2.2.3, lane 35):
// one listener reads every key through keys.ts and does what it says, and
// the sheet `?` opens lists the same table for the screen shown.
//
// A screen that handles a key itself calls preventDefault, and the shell
// leaves that key alone. J and K walk the rows of the screen shown: the
// tower's ([data-row]), the sessions index's, the inbox's items; Enter
// opens the row walked to, Esc leaves it. 1 to 4 press a session's tabs.
import { X } from '@phosphor-icons/react';
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button.tsx';
import type { Translate } from '@/lib/i18n.ts';
import type { ScreenName } from '@/lib/routes.ts';
import { Keys } from './Kbd.tsx';
import { resolveKey, sheetRows, type Action, type Chord, type Focus, type Scope } from './keys.ts';
import { trapTab, useFocusBack } from './Palette.tsx';

// The session screen's tabs in the order 1 to 4 press them (TABS in screens/session/tabs.ts).
export const SESSION_TABS = ['plan', 'terminal', 'editor', 'browser'] as const;

// The rows J and K walk, in the screen shown (a kept session hidden is not).
export const ROWS = '#screen [data-row], #screen .index a.open, #screen a.item';

export function focusOf(target: EventTarget | null): Focus {
  if (!(target instanceof Element)) return 'none';
  if (target.closest('.xterm')) return 'terminal';
  if (target.closest('textarea, select, [contenteditable=""], [contenteditable="true"]')) return 'field';
  if (target instanceof HTMLInputElement) return ['button', 'submit', 'checkbox', 'radio', 'reset'].includes(target.type) ? 'control' : 'field';
  if (target.closest('a[href], button, summary, [role="tab"], [role="button"], [role="option"]')) return 'control';
  return 'none';
}

const visible = (element: Element) => element.getClientRects().length > 0;

export function rowsShown(root: ParentNode = document): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(ROWS)].filter(visible);
}

export type KeyHandlers = {
  readonly screen: ScreenName;
  readonly overlay: boolean;
  readonly mac: boolean;
  readonly run: (action: Action) => void;
};

// The one keydown listener of the page.
export function useShortcuts(handlers: KeyHandlers): void {
  const latest = useRef(handlers);
  latest.current = handlers;
  const chord = useRef<Chord>(null);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const { screen, overlay, mac, run } = latest.current;
      const read = resolveKey(
        { key: event.key, meta: event.metaKey, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, composing: event.isComposing },
        { screen, focus: focusOf(event.target), overlay, mac, now: performance.now() },
        chord.current,
      );
      chord.current = read.chord;
      if (!read.action) return;
      event.preventDefault();
      run(read.action);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

// J, K, Enter and Esc on the rows of the screen shown.
export function walkRows(action: 'next' | 'previous' | 'open' | 'back', last: { current: HTMLElement | null }): void {
  const rows = rowsShown();
  const current = rows.indexOf(document.activeElement as HTMLElement);
  if (action === 'open') {
    if (last.current?.isConnected && visible(last.current)) last.current.click();
    return;
  }
  if (action === 'back') {
    if (current >= 0) document.getElementById('screen')?.focus({ preventScroll: true });
    last.current = null;
    return;
  }
  if (rows.length === 0) return;
  const from = current >= 0 ? current : last.current ? rows.indexOf(last.current) : -1;
  const next = action === 'next' ? Math.min(rows.length - 1, from + 1) : from < 0 ? 0 : Math.max(0, from - 1);
  const row = rows[next]!;
  last.current = row;
  row.focus({ preventScroll: true });
  row.scrollIntoView({ block: 'nearest' });
}

export function pressTab(n: number): void {
  const name = SESSION_TABS[n - 1];
  if (name) document.getElementById(`tab-${name}-button`)?.click();
}

const SCOPES: readonly Scope[] = ['global', 'list', 'session', 'field'];

export function ShortcutSheet({ t, screen, mac, onClose }: { readonly t: Translate; readonly screen: ScreenName; readonly mac: boolean; readonly onClose: () => void }) {
  useFocusBack();
  const close = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { close.current?.focus(); }, []);
  const rows = sheetRows(screen);
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' || event.key === '?') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    trapTab(event);
  };
  return (
    <div className="overlay" data-overlay="sheet" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="dialog sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" id="shortcuts" onKeyDown={keyDown}>
        <div className="sheet-head">
          <h2 id="sheet-title">{t('keys_title')}</h2>
          <Button variant="ghost" className="icon" id="sheet-close" aria-label={t('keys_close')} ref={close} onClick={onClose}><X size={16} aria-hidden="true" /></Button>
        </div>
        <div className="sheet-body">
          {SCOPES.map((scope) => {
            const here = rows.filter((row) => row.scope === scope);
            if (here.length === 0) return null;
            return (
              <section key={scope} aria-labelledby={`keys-${scope}`}>
                <h3 id={`keys-${scope}`}>{t(`keys_group_${scope}`)}</h3>
                <ul>{here.map((row) => <li key={row.id} data-shortcut={row.id}><span>{t(row.label)}</span><Keys keys={row.keys} t={t} mac={mac} /></li>)}</ul>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
