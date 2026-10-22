// The session screen's four tabs (decision 30, lane 20): the strip, with
// Take over or Give back beside it, and what each tab shows. Session.tsx
// holds their state and calls the routes; tabs.ts holds the rules.
import { Browser, Check, Circle, Code, ListChecks, TerminalWindow, type Icon } from '@phosphor-icons/react';
import type { FormEvent, KeyboardEvent } from 'react';
import type { SessionFile, SessionFiles, SessionPlan } from '../../../../src/api/types.ts';
import { Button } from '@/components/ui/button.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import type { Translate } from '@/lib/i18n.ts';
import { ENDED, clock, parseCriteria, phaseOf, takenOverOf, type SessionView } from './model.ts';
import {
  CHANGE_MAX, TABS, cutNote, fileLines, goLine, lineDiff, planView, resumeCommand, type BrowserView, type DiffLine, type Tab, type TakeoverView,
} from './tabs.ts';

const ICONS: Readonly<Record<Tab, Icon>> = { plan: ListChecks, terminal: TerminalWindow, editor: Code, browser: Browser };

export function TabStrip({ tab, t, takeover, busy = false, onSelect, onKey, onTakeover, onGiveback }: {
  readonly tab: Tab; readonly t: Translate; readonly takeover: TakeoverView; readonly busy?: boolean;
  readonly onSelect?: (tab: Tab) => void; readonly onKey?: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onTakeover?: () => void; readonly onGiveback?: () => void;
}) {
  return (
    <div className="panel-tabs">
      <div className="view-tabs" role="tablist" aria-label={t('tabs_label')} onKeyDown={onKey}>
        {TABS.map((name) => {
          const Mark = ICONS[name];
          const selected = name === tab;
          return (
            <button key={name} type="button" role="tab" id={`tab-${name}-button`} className={selected ? 'view-tab current' : 'view-tab'}
              aria-selected={selected} aria-controls={`tab-${name}`} tabIndex={selected ? 0 : -1} onClick={() => onSelect?.(name)}>
              <Mark size={15} aria-hidden="true" />{t(`tabs_${name}`)}
            </button>
          );
        })}
      </div>
      {takeover.kind === 'free' && takeover.can
        ? <Button className="btn" id="takeover" title={t('takeover_note')} disabled={busy} onClick={onTakeover}>{t('takeover')}</Button> : null}
      {takeover.kind === 'mine' ? <Button variant="ink" className="btn primary" id="giveback" disabled={busy} onClick={onGiveback}>{t('giveback')}</Button> : null}
    </div>
  );
}

export function Criteria({ view, t }: { readonly view: SessionView; readonly t: Translate }) {
  const parsed = parseCriteria(view.ticket?.body ?? '');
  if (parsed.criteria.length === 0) return <p className="faint small">{t('criteria_none')}</p>;
  return (
    <ul className="criteria">
      {parsed.criteria.map((c, index) => (
        <li key={index} className={c.done ? 'crit-done' : 'crit-open'}>
          <span className="mark" aria-hidden="true">{c.done ? <Check size={13} /> : <Circle size={13} />}</span>
          <span>{c.text}</span>
          <span className="sr-only">{t(c.done ? 'criterion_done' : 'criterion_open')}</span>
        </li>
      ))}
    </ul>
  );
}

export const Confidence = ({ plan, t }: { readonly plan: SessionPlan; readonly t: Translate }) =>
  <span className={`confidence ${plan.confidence}`}>{t(`confidence_${plan.confidence}`)}</span>;

// The Plan tab: the session plan with its confidence, Go and Change while it
// waits, who gave the Go after; then the ticket's criteria.
export function PlanTab({ view, plan, t, changing = false, change = '', busy = false, note = '', onGo, onChangeOpen, onChangeText, onChangeSend, onChangeCancel }: {
  readonly view: SessionView; readonly plan: SessionPlan | null; readonly t: Translate;
  readonly changing?: boolean; readonly change?: string; readonly busy?: boolean; readonly note?: string;
  readonly onGo?: () => void; readonly onChangeOpen?: () => void; readonly onChangeText?: (text: string) => void;
  readonly onChangeSend?: (event: FormEvent<HTMLFormElement>) => void; readonly onChangeCancel?: () => void;
}) {
  const takenOver = takenOverOf(view) !== null;
  const shown = planView(plan, { ended: ENDED.has(phaseOf(view)), takenOver });
  return (
    <div className="plan-tab">
      <section className="card" aria-labelledby="plan-tab-title">
        <div className="plan-head">
          <h3 id="plan-tab-title" className="card-label">{t('plan_tab_title')}</h3>
          {shown.kind === 'plan' ? <Confidence plan={shown.plan} t={t} /> : null}
        </div>
        {shown.kind === 'none' ? <p className="faint small">{t('plan_empty')}</p> : (
          <>
            <p className="plan-reason">{shown.plan.reason}</p>
            <h4 className="card-label sub-label">{t('plan_steps_title')}</h4>
            <ol className="plan-steps">{shown.plan.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>
            <h4 className="card-label sub-label">{t('plan_files_title')}</h4>
            <ul className="plan-files">{shown.plan.files.map((file) => <li key={file} className="path">{file}</li>)}</ul>
            {shown.waiting ? (
              <div className="plan-go" data-plan-state="waiting">
                <p className="plan-waiting"><span className="dot waiting" aria-hidden="true" />{t('plan_waiting')}</p>
                <p className="faint small">{t(takenOver ? 'plan_waiting_taken_over' : 'plan_waiting_note')}</p>
                {shown.canAct && !changing ? (
                  <div className="plan-actions">
                    <Button variant="ink" className="btn primary" data-act="plan_go" disabled={busy} onClick={onGo}>{t('plan_go')}</Button>
                    <Button className="btn" data-act="plan_change" disabled={busy} onClick={onChangeOpen}>{t('plan_change')}</Button>
                  </div>
                ) : null}
                {shown.canAct && changing ? (
                  <form className="plan-change" onSubmit={onChangeSend}>
                    <label htmlFor="plan-change" className="small">{t('plan_change_label')}</label>
                    <Textarea id="plan-change" maxLength={CHANGE_MAX} rows={3} value={change} disabled={busy} onChange={(event) => onChangeText?.(event.target.value)} />
                    <div className="plan-actions">
                      <Button variant="ink" className="btn primary" type="submit" data-act="plan_change_send" disabled={busy}>{t('plan_change_send')}</Button>
                      <Button className="btn" data-act="plan_change_cancel" disabled={busy} onClick={onChangeCancel}>{t('plan_change_cancel')}</Button>
                    </div>
                  </form>
                ) : null}
                <p className="plan-note" role="status">{note}</p>
              </div>
            ) : <p className="go-line" data-plan-state="go"><Check size={14} aria-hidden="true" />{goLine(shown.plan, view.me, t)}</p>}
          </>
        )}
      </section>
      <section className="card" aria-labelledby="plan-criteria-title">
        <h3 id="plan-criteria-title" className="card-label">{t('criteria_title')}</h3>
        <Criteria view={view} t={t} />
      </section>
    </div>
  );
}

// The Terminal tab of a session taken over: what is paused, and the command
// that resumes the session in its container, on the server.
export function TakeoverNotice({ view, t }: { readonly view: SessionView; readonly t: Translate }) {
  const taken = takenOverOf(view);
  if (!taken || ENDED.has(phaseOf(view))) return null;
  const time = clock(taken.at);
  return (
    <div className="takeover" role="note">
      <p className="takeover-title">{taken.by === view.me ? t('takeover_title', { time }) : t('takeover_other_title', { time })}</p>
      <p className="takeover-body">{t('takeover_body')}</p>
      <pre className="command"><code id="resume-command">{resumeCommand(view.summary.id)}</code></pre>
      <p className="takeover-body">{t('takeover_after')}</p>
    </div>
  );
}

function Counts({ added, removed }: { readonly added: number; readonly removed: number }) {
  return <><span className="add">+{added}</span>{removed > 0 ? <>{' '}<span className="del">−{removed}</span></> : null}</>;
}

const SIGN: Readonly<Record<DiffLine['kind'], string>> = { same: ' ', add: '+', del: '−' };

export type EditorShown = { readonly file: SessionFile | null; readonly base: SessionFile | null; readonly error?: string };

// The Editor tab, read only: the changed files, and the one picked, as its
// changes against the ticket's base or as the whole file.
export function EditorTab({ t, files, selected, shown, mode, failed = false, onSelect, onMode }: {
  readonly t: Translate; readonly files: SessionFiles['files']; readonly selected?: string | undefined; readonly shown?: EditorShown | undefined;
  readonly mode: 'diff' | 'file'; readonly failed?: boolean; readonly onSelect?: (path: string) => void; readonly onMode?: (mode: 'diff' | 'file') => void;
}) {
  const lines = shown?.file ? (mode === 'diff' ? lineDiff(shown.base?.text, shown.file.text) : fileLines(shown.file.text)) : [];
  const cut = shown?.file ? cutNote(shown.file, t) : undefined;
  return (
    <div className="editor">
      <nav className="editor-files" aria-label={t('editor_files')}>
        <h3 className="card-label">{t('editor_files')}</h3>
        {files.length === 0 ? <p className="faint small">{t('changes_none')}</p> : (
          <ul>
            {files.map((file) => (
              <li key={file.path}>
                <button type="button" className="file-pick" data-file={file.path} aria-current={file.path === selected ? 'true' : undefined} onClick={() => onSelect?.(file.path)}>
                  <span className="path">{file.path}</span><span className="counts"><Counts added={file.added} removed={file.removed} /></span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>
      <div className="editor-view">
        {selected === undefined ? (files.length > 0 ? <p className="faint small">{t('editor_pick')}</p> : null) : (
          <>
            <div className="editor-bar">
              <span className="path">{selected}</span>
              {shown?.file && shown.base === null ? <span className="tag">{t('editor_new')}</span> : null}
              <div className="mode" role="group" aria-label={t('editor_mode')}>
                <button type="button" aria-pressed={mode === 'diff'} onClick={() => onMode?.('diff')}>{t('editor_diff')}</button>
                <button type="button" aria-pressed={mode === 'file'} onClick={() => onMode?.('file')}>{t('editor_file')}</button>
              </div>
              <span className="read-only">{t('editor_read_only')}</span>
            </div>
            {shown?.error !== undefined ? <p className="editor-note bad">{t('editor_refused', { reason: shown.error })}</p>
              : failed ? <p className="editor-note bad">{t('editor_failed')}</p>
              : !shown?.file ? <p className="editor-note faint">{t('editor_loading')}</p> : (
                <div className="code-scroll" tabIndex={0}>
                  <table className="code" aria-label={t('editor_lines', { path: selected })}>
                    <tbody>
                      {lines.map((line, index) => (
                        <tr className={`line ${line.kind}`} key={index}>
                          <td className="num">{mode === 'diff' ? line.old ?? '' : line.new}</td>
                          {mode === 'diff' ? <td className="num">{line.new ?? ''}</td> : null}
                          <td className="sign" aria-hidden="true">{SIGN[line.kind]}</td>
                          <td className="text"><code>{line.text}</code></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            {cut ? <p className="editor-note faint">{cut}</p> : null}
          </>
        )}
      </div>
    </div>
  );
}

// The Browser tab: the trial environment in a sandboxed frame, from the
// preview listener's own origin; never allow-same-origin.
export function BrowserTab({ view, t }: { readonly view: BrowserView; readonly t: Translate }) {
  if (view.kind === 'frame') {
    return (
      <figure className="browser">
        <iframe title={t('browser_frame_title')} src={view.src} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" />
        <figcaption className="faint small">{t('browser_note')}</figcaption>
      </figure>
    );
  }
  return <div className="browser-empty"><p className="empty-box">{t(view.kind === 'here_only' ? 'browser_here_only' : 'screen_empty')}</p></div>;
}
