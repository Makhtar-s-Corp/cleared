// The web terminal of a session taken over (decision 32, lane 32): xterm on
// the terminal's routes, mounted on the session screen's Terminal tab for
// the account that took the session over, on the app's loopback address.
//   - It opens on the session's own harness, resumed on the session (owner
//     request of 2026-10-22 17:26); Shell, the second choice, closes it and
//     opens a shell in the container, and a button goes back. A harness
//     that cannot be resumed says why, with the Shell beside it.
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
//   - The setup assistant's model step mounts it too (lane v2-j5-assistant):
//     its routes at `root`, a shell only (`fixedMode`), no switch.
import { useEffect, useRef, useState, type Ref } from 'react';
import type { TerminalChunk, TerminalClosed, TerminalMode } from '../../../../src/api/types.ts';
import { Button } from '@/components/ui/button.tsx';
import type { Translate } from '@/lib/i18n.ts';
import { DEFAULT_MODE, InputBatcher, closedLine, freshChunk, otherMode, pageNonce, screenShims, terminalApi, type TerminalStatus } from './model.ts';

// harness: the harness's name; canHarness: false once it said it cannot be resumed.
export function TerminalFrame({ t, status, mode = DEFAULT_MODE, harness = '', canHarness = true, host, note = '', onOpen, onSwitch }: {
  readonly t: Translate; readonly status: TerminalStatus; readonly mode?: TerminalMode; readonly harness?: string; readonly canHarness?: boolean;
  readonly host?: Ref<HTMLDivElement>; readonly note?: string; readonly onOpen?: () => void; readonly onSwitch?: () => void;
}) {
  const closed = status.kind === 'closed' ? status : undefined;
  const name = harness;
  const shell = mode === 'shell';
  const line = status.kind === 'opening' ? (shell ? t('terminal_opening') : t('terminal_opening_harness', { name }))
    : status.kind === 'open' ? (shell ? t('terminal_open', { cols: status.cols, rows: status.rows }) : t('terminal_open_harness', { name, cols: status.cols, rows: status.rows }))
    : closed?.reason === 'unsupported' && closed.detail ? closed.detail     // the adapter's own reason, once
    : closedLine(status.reason, t, mode);
  const unsupported = closed?.reason === 'unsupported';
  const given = closed?.reason === 'give_back';
  const canSwitch = !given && (shell ? canHarness : true);
  const again = closed && !given && closed.reason !== 'unsupported';
  return (
    <section className="term" aria-label={t('terminal_label')} data-terminal-state={status.kind} data-reason={closed?.reason} data-mode={mode}>
      <div className="term-head">
        <p className="term-mode">{shell ? t('terminal_mode_shell') : unsupported ? t('terminal_mode_unsupported', { name }) : t('terminal_mode_harness', { name })}</p>
        {canSwitch ? (
          <Button className="btn term-switch" data-act={shell ? 'terminal_harness' : 'terminal_shell'} onClick={onSwitch}>
            {shell ? t('terminal_switch_harness', { name }) : t('terminal_switch_shell')}
          </Button>
        ) : null}
      </div>
      <div className="term-host" ref={host} />
      <div className="term-foot">
        <p className="term-state" role="status" title={status.kind === 'open' ? t('terminal_journaled') : undefined}>
          <span className="dot" data-state={status.kind} aria-hidden="true" />
          <span>{line}</span>
          {status.kind === 'open' ? <span className="sr-only">{t('terminal_journaled')}</span> : null}
          {closed?.detail && !unsupported ? <span className="term-detail">{closed.detail}</span> : null}
          {note ? <span className="term-detail bad">{note}</span> : null}
        </p>
        {again ? <Button className="btn" data-act="terminal_open" onClick={onOpen}>{t('terminal_open_again')}</Button> : null}
      </div>
    </section>
  );
}

// The terminal's colours from the page's tokens: white, its text the
// theme's contrast, as every panel of the one light theme (issue #461); the
// ANSI colours darkened so each reads at 5:1 or more on white (white and
// bright white drawn as greys, so a program's "white" text still shows).
const ANSI = { black: '#1A1C21', brightBlack: '#6B6E75', red: '#B4192C', brightRed: '#C0283A', green: '#17703D', brightGreen: '#1C7A45', yellow: '#8A5A00', brightYellow: '#946200', blue: '#3845B0', brightBlue: '#4250C4', magenta: '#7E3AAB', brightMagenta: '#8B47B8', cyan: '#0B6E7D', brightCyan: '#0B7A8A', white: '#5F6166', brightWhite: '#3D4048' };
function themeOf(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const background = token('--theme-base', '#FFFFFF');
  const foreground = token('--theme-contrast', '#1A1C21');
  return { ...ANSI, background, foreground, cursor: foreground, cursorAccent: background, selectionBackground: token('--halo-progress', '#DCE0F7') };
}

// Fit only a terminal that is shown: a hidden one measures nothing.
const shown = (element: HTMLElement | null): element is HTMLElement => !!element && element.offsetWidth > 0 && element.offsetHeight > 0;

export function WebTerminal({ session, csrf, active, t, harness, root, fixedMode }: {
  readonly session: string; readonly csrf: string; readonly active: boolean; readonly t: Translate; readonly harness: string;
  readonly root?: string; readonly fixedMode?: TerminalMode;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<TerminalStatus>({ kind: 'opening' });
  const [note, setNote] = useState('');
  const [started, setStarted] = useState(active);
  const [attempt, setAttempt] = useState(0);
  const [mode, setMode] = useState<TerminalMode>(fixedMode ?? DEFAULT_MODE);
  const [name, setName] = useState(harness);
  const [canHarness, setCanHarness] = useState(fixedMode === undefined);
  const switching = useRef(false);                          // a switch closes the terminal: its `closed` frame is not shown
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
        fontSize: element.offsetWidth > 0 && element.offsetWidth < 480 ? 12 : 13, lineHeight: 1.2, cursorBlink: true, scrollback: 2000, theme,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(element);
      cleanups.unshift(() => term.dispose());
      refit.current = () => { if (shown(element)) fit.fit(); };
      refit.current();

      const api = terminalApi(session, csrf, undefined, root);
      const batcher = new InputBatcher({ send: api.input, onError: () => setNote(words.current('terminal_input_failed')) });
      cleanups.unshift(() => batcher.dispose());
      term.onData((data) => batcher.push(data));

      const opened = await api.open({ cols: term.cols, rows: term.rows }, mode).catch((): { kind: 'lost' } => ({ kind: 'lost' }));
      if (disposed) return;
      switching.current = false;
      if (opened.kind === 'lost') return setStatus({ kind: 'closed', reason: 'lost' });
      if (opened.kind === 'refused') return setStatus({ kind: 'closed', reason: 'refused', detail: opened.reason });
      if (opened.kind === 'unsupported') {
        setCanHarness(false);
        return setStatus({ kind: 'closed', reason: 'unsupported', detail: opened.reason });
      }
      // Another mode is open (a reload of the page after a switch): attach to that one.
      if (opened.kind === 'attach' && opened.mode !== mode) return setMode(opened.mode);
      if (opened.kind === 'opened' && opened.name) setName(opened.name);
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
        if (switching.current) return;
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

      setStatus({ kind: 'open', cols: term.cols, rows: term.rows });
      term.focus();
    })().catch(() => { if (!disposed) setStatus({ kind: 'closed', reason: 'lost' }); });
    return () => {
      disposed = true;
      refit.current = () => {};
      for (const cleanup of cleanups) cleanup();
    };
  }, [started, attempt, session, csrf, mode, root]);

  // Shell, or back to the harness: one terminal at a time, so the one open
  // closes first (the harness leaves, its transcript kept), then the other opens.
  const switchMode = () => {
    const next = otherMode(mode);
    switching.current = true;
    setStatus({ kind: 'opening' });
    void terminalApi(session, csrf, undefined, root).close().catch(() => {}).then(() => {
      setMode(next);
      setAttempt((n) => n + 1);
    });
  };

  return <TerminalFrame t={t} status={status} mode={mode} harness={name} canHarness={canHarness} host={host} note={note}
    onOpen={() => setAttempt((n) => n + 1)} onSwitch={switchMode} />;
}
