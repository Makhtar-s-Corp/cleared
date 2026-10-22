// The web terminal of a session taken over (decision 32, lane 32): xterm on
// the terminal's routes, mounted on the session screen's Terminal tab for
// the account that took the session over, on the app's loopback address.
//   - xterm and its sheet load by a dynamic import (xterm.ts), so no other
//     screen grows; the first open waits until the tab is shown, since a
//     hidden terminal has no size to give the shell.
//   - The page's style nonce reaches xterm's <style> elements and colour
//     attributes through lib/style-nonce.ts's two shims, held from just
//     before term.open() until the terminal is disposed, once per screen.
//   - Open, then the stream: an open answered 409 is a terminal already
//     open (a reload of the page), whose stream replays what it holds. The
//     stream's `closed` frame ends it, with its reason; a stream that gives
//     up is "lost". Open again opens a new one.
//   - The keys go through the model's batcher; the size follows the panel.
import { useEffect, useRef, useState, type Ref } from 'react';
import type { TerminalChunk, TerminalClosed } from '../../../../src/api/types.ts';
import { Button } from '@/components/ui/button.tsx';
import type { Translate } from '@/lib/i18n.ts';
import { InputBatcher, closedLine, freshChunk, pageNonce, screenShims, terminalApi, type TerminalStatus } from './model.ts';

export function TerminalFrame({ t, status, host, note = '', onOpen }: {
  readonly t: Translate; readonly status: TerminalStatus; readonly host?: Ref<HTMLDivElement>; readonly note?: string; readonly onOpen?: () => void;
}) {
  const closed = status.kind === 'closed' ? status : undefined;
  const line = status.kind === 'opening' ? t('terminal_opening')
    : status.kind === 'open' ? t('terminal_open', { cols: status.cols, rows: status.rows })
    : closedLine(status.reason, t);
  return (
    <section className="term" aria-label={t('terminal_label')} data-terminal-state={status.kind} data-reason={closed?.reason}>
      <div className="term-host" ref={host} />
      <div className="term-foot">
        <p className="term-state" role="status">
          <span className="dot" data-state={status.kind} aria-hidden="true" />
          <span>{line}</span>
          {closed?.detail ? <span className="term-detail">{closed.detail}</span> : null}
          {note ? <span className="term-detail bad">{note}</span> : null}
        </p>
        {closed && closed.reason !== 'give_back' ? <Button className="btn" data-act="terminal_open" onClick={onOpen}>{t('terminal_open_again')}</Button> : null}
      </div>
    </section>
  );
}

// The terminal's colours from the page's tokens, as the command block's:
// ink with its text in light, the canvas in dark.
function themeOf(): { background: string; foreground: string; cursor: string; cursorAccent: string; selectionBackground: string } {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const dark = document.documentElement.dataset.theme === 'dark';
  const background = dark ? token('--canvas', '#0A0A0A') : token('--ink', '#171717');
  const foreground = dark ? token('--text', '#EDEDED') : token('--on-ink', '#FFFFFF');
  return { background, foreground, cursor: foreground, cursorAccent: background, selectionBackground: 'rgba(82, 168, 255, 0.35)' };
}

// Fit only a terminal that is shown: a hidden one measures nothing.
const shown = (element: HTMLElement | null): element is HTMLElement => !!element && element.offsetWidth > 0 && element.offsetHeight > 0;

export function WebTerminal({ session, csrf, active, t }: { readonly session: string; readonly csrf: string; readonly active: boolean; readonly t: Translate }) {
  const host = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<TerminalStatus>({ kind: 'opening' });
  const [note, setNote] = useState('');
  const [started, setStarted] = useState(active);
  const [attempt, setAttempt] = useState(0);
  const refit = useRef<() => void>(() => {});
  const words = useRef(t);                                   // the catalog, without reopening the terminal when it changes
  words.current = t;

  useEffect(() => { if (active) setStarted(true); }, [active]);
  // Back on the tab: the panel may have changed size while it was hidden.
  useEffect(() => { if (active) refit.current(); }, [active]);

  useEffect(() => {
    if (!started) return;
    let disposed = false;
    const cleanups: (() => void)[] = [];
    setStatus({ kind: 'opening' });
    setNote('');
    void (async () => {
      const [{ Terminal, FitAddon }] = await Promise.all([import('./xterm.ts'), document.fonts?.load('13px "Geist Mono"').catch(() => undefined)]);
      const element = host.current;
      if (disposed || !element) return;
      cleanups.push(screenShims.hold(pageNonce(document)));
      const theme = themeOf();
      const term = new Terminal({
        fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'monospace',
        fontSize: 13, lineHeight: 1.2, cursorBlink: true, scrollback: 2000, theme,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(element);
      cleanups.unshift(() => term.dispose());
      refit.current = () => { if (shown(element)) fit.fit(); };
      refit.current();

      const api = terminalApi(session, csrf);
      const batcher = new InputBatcher({ send: api.input, onError: () => setNote(words.current('terminal_input_failed')) });
      cleanups.unshift(() => batcher.dispose());
      term.onData((data) => batcher.push(data));

      const opened = await api.open({ cols: term.cols, rows: term.rows }).catch((): { kind: 'lost' } => ({ kind: 'lost' }));
      if (disposed) return;
      if (opened.kind === 'lost') return setStatus({ kind: 'closed', reason: 'lost' });
      if (opened.kind === 'refused') return setStatus({ kind: 'closed', reason: 'refused', detail: opened.reason });
      if (opened.kind === 'attach') void api.resize({ cols: term.cols, rows: term.rows }).catch(() => {});

      // The output, each chunk once; the stream ends with its reason.
      let last = 0;
      let ended = false;
      const stream = new EventSource(api.streamUrl);
      cleanups.unshift(() => stream.close());
      stream.addEventListener('data', (event) => {
        const chunk = JSON.parse((event as MessageEvent<string>).data) as TerminalChunk;
        if (!freshChunk(last, chunk)) return;
        last = chunk.seq;
        term.write(chunk.data);
      });
      stream.addEventListener('closed', (event) => {
        ended = true;
        stream.close();
        batcher.dispose();
        term.options.disableStdin = true;
        setStatus({ kind: 'closed', reason: (JSON.parse((event as MessageEvent<string>).data) as TerminalClosed).reason });
      });
      stream.addEventListener('error', () => {
        if (!ended && stream.readyState === EventSource.CLOSED) {
          batcher.dispose();
          setStatus({ kind: 'closed', reason: 'lost' });
        }
      });

      // The size follows the panel; the shell is told the last one.
      let pending: ReturnType<typeof setTimeout> | undefined;
      term.onResize(({ cols, rows }) => {
        setStatus((current) => (current.kind === 'open' ? { kind: 'open', cols, rows } : current));
        clearTimeout(pending);
        pending = setTimeout(() => void api.resize({ cols, rows }).catch(() => {}), 150);
      });
      cleanups.unshift(() => clearTimeout(pending));
      const sized = new ResizeObserver(() => refit.current());
      sized.observe(element);
      cleanups.unshift(() => sized.disconnect());
      // The theme follows the page's.
      const themed = new MutationObserver(() => { term.options.theme = themeOf(); });
      themed.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      cleanups.unshift(() => themed.disconnect());

      setStatus({ kind: 'open', cols: term.cols, rows: term.rows });
      term.focus();
    })().catch(() => { if (!disposed) setStatus({ kind: 'closed', reason: 'lost' }); });
    return () => {
      disposed = true;
      refit.current = () => {};
      for (const cleanup of cleanups) cleanup();
    };
  }, [started, attempt, session, csrf]);

  return <TerminalFrame t={t} status={status} host={host} note={note} onOpen={() => setAttempt((n) => n + 1)} />;
}
