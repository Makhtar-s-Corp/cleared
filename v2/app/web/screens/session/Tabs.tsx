// The session screen's four tabs (decision 30, lane 20): the strip, and
// what each tab shows; Take over or Give back sit in the thread's header
// (lane 36), on the ticket's live session whatever its role. Session.tsx
// holds their state and calls the routes; tabs.ts holds the rules. Lane 32
// adds the web terminal beside the command (components/terminal/) and the
// editor in the Editor tab (components/editor/).
import { Browser, Check, Circle, Code, ListChecks, TerminalWindow, type Icon } from '@phosphor-icons/react';
import type { FormEvent, KeyboardEvent } from 'react';
import { Editing, type EditorHandlers } from '@/components/editor/Editor.tsx';
import { isDirty, type EditorState, type ReadOnlyWhy, type Scope } from '@/components/editor/model.ts';
import type { EditorLinks, SessionFile, SessionFiles, SessionPlan } from '../../../../src/api/types.ts';
import { Button } from '@/components/ui/button.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { Empty } from '@/shell/Empty.tsx';
import type { Translate } from '@/lib/i18n.ts';
import { quantity } from '@/lib/time.ts';
import { ENDED, clock, parseCriteria, phaseOf, takenOverOf, type SessionView } from './model.ts';
import { QUESTION_MAX } from '@/screens/ask/model.ts';
import {
  CHANGE_MAX, TABS, cutNote, fileLines, goLine, lineDiff, planAskScope, planView, stepCost, stepLine, stepsView, type BrowserView, type DiffLine, type Tab, type TakeoverView,
} from './tabs.ts';
import { Counts } from './Counts.tsx';

const ICONS: Readonly<Record<Tab, Icon>> = { plan: ListChecks, terminal: TerminalWindow, editor: Code, browser: Browser };

export function TabStrip({ tab, t, onSelect, onKey }: {
  readonly tab: Tab; readonly t: Translate; readonly onSelect?: (tab: Tab) => void; readonly onKey?: (event: KeyboardEvent<HTMLDivElement>) => void;
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
    </div>
  );
}

// Take over stops the session and opens it for the person; Give back hands
// it back and tells it what the person changed (Devin's contract).
export function TakeoverButton({ t, takeover, busy = false, onTakeover, onGiveback }: {
  readonly t: Translate; readonly takeover: TakeoverView; readonly busy?: boolean; readonly onTakeover?: () => void; readonly onGiveback?: () => void;
}) {
  if (takeover.kind === 'free' && takeover.can) return <Button className="btn takeover-button" id="takeover" title={t('takeover_note')} disabled={busy} onClick={onTakeover}>{t('takeover')}</Button>;
  if (takeover.kind === 'mine') return <Button variant="ink" className="btn primary takeover-button" id="giveback" title={t('giveback_note')} disabled={busy} onClick={onGiveback}>{t('giveback')}</Button>;
  return null;
}

// Open in an editor (flow/editor.ts): one button that reveals a link per
// editor. The links are plain anchors: the person's own browser hands the
// address to their own editor, and the page runs nothing.
export function OpenInEditor({ t, offer, expanded = false, onToggle }: {
  readonly t: Translate; readonly offer: EditorLinks | null; readonly expanded?: boolean; readonly onToggle?: () => void;
}) {
  if (!offer) return null;
  return (
    <div className="open-editor">
      <Button className="btn open-editor-button" id="open-editor" title={t('open_editor_note')} aria-expanded={expanded} aria-controls="open-editor-links" onClick={onToggle}>{t('open_editor')}</Button>
      {expanded ? (
        <div className="open-editor-links" id="open-editor-links" role="group" aria-label={t('open_editor')}>
          {offer.links.map((link) => <a key={link.editor} className="btn" data-editor={link.editor} href={link.url}>{t(`open_editor_${link.editor}`)}</a>)}
          {offer.mode === 'ssh' ? <span className="faint small">{t('open_editor_ssh')}</span> : null}
        </div>
      ) : null}
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

// The ticket's steps across services (decision 26): each with its kind, its
// service, what it waits for, its state and its cost; this session's marked.
export function StepsCard({ view, t }: { readonly view: SessionView; readonly t: Translate }) {
  const steps = stepsView(view.steps, view.summary.id);
  if (!steps) return null;
  return (
    <section className="card steps-card" aria-labelledby="ticket-steps-title">
      <h3 id="ticket-steps-title" className="card-label">{t('ticket_steps_title')}</h3>
      <ol className="ticket-steps">
        {steps.rows.map((row) => {
          const cost = stepCost(row, view.language, t);
          return (
            <li key={row.position} className={row.current ? 'ticket-step current' : 'ticket-step'} data-step={row.position} data-state={row.state} aria-current={row.current ? 'step' : undefined}>
              <span className="step-n" aria-hidden="true">{row.position}</span>
              <span className="step-what">{stepLine(row, t)}{row.current ? <span className="step-this">{t('ticket_step_this')}</span> : null}</span>
              <span className={`step-state ${row.state}`}>{t(`ticket_step_${row.state}`)}</span>
              {cost ? <span className="step-cost">{cost}</span> : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// A question to the code from the Plan tab (decision 28): sent to the
// reader about the session's service, whatever the session's state; the
// answer and its cost open on the /ask/:id screen.
export type PlanAsk = { readonly text: string; readonly busy: boolean; readonly status: string };

export function PlanAskCard({ service, t, ask = { text: '', busy: false, status: '' }, onText, onSend }: {
  readonly service: string | undefined; readonly t: Translate; readonly ask?: PlanAsk;
  readonly onText?: (text: string) => void; readonly onSend?: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <section className="card plan-ask" aria-labelledby="plan-ask-title">
      <h3 id="plan-ask-title" className="card-label">{t('plan_ask_title')}</h3>
      <form id="plan-ask" autoComplete="off" onSubmit={onSend}>
        {/* The card's title says what the field is for: its label is read out, not drawn twice (P221). */}
        <label htmlFor="plan-ask-input" className="sr-only">{t('plan_ask_label')}</label>
        <Textarea id="plan-ask-input" name="question" maxLength={QUESTION_MAX} rows={3} placeholder={t('plan_ask_placeholder')} value={ask.text} disabled={ask.busy}
          onChange={(event) => onText?.(event.target.value)} />
        <p className="faint small">{planAskScope(service, t)}</p>
        <div className="plan-actions">
          <Button variant="ink" className="btn primary" type="submit" data-act="plan_ask" disabled={ask.busy}>{t('plan_ask_send')}</Button>
        </div>
        <p className="plan-ask-note" role="status">{ask.status}</p>
      </form>
    </section>
  );
}

// The Plan tab: the session plan with its confidence, Go and Change while it
// waits, who gave the Go after; the ticket's steps across services; the
// ticket's criteria; then a question to the code.
export function PlanTab({ view, plan, t, changing = false, change = '', busy = false, note = '', ask, onGo, onChangeOpen, onChangeText, onChangeSend, onChangeCancel, onAskText, onAskSend }: {
  readonly view: SessionView; readonly plan: SessionPlan | null; readonly t: Translate;
  readonly changing?: boolean; readonly change?: string; readonly busy?: boolean; readonly note?: string; readonly ask?: PlanAsk;
  readonly onGo?: () => void; readonly onChangeOpen?: () => void; readonly onChangeText?: (text: string) => void;
  readonly onChangeSend?: (event: FormEvent<HTMLFormElement>) => void; readonly onChangeCancel?: () => void;
  readonly onAskText?: (text: string) => void; readonly onAskSend?: (event: FormEvent<HTMLFormElement>) => void;
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
      <StepsCard view={view} t={t} />
      <section className="card" aria-labelledby="plan-criteria-title">
        <h3 id="plan-criteria-title" className="card-label">{t('criteria_title')}</h3>
        <Criteria view={view} t={t} />
      </section>
      <PlanAskCard service={view.summary.service} t={t} ask={ask} onText={onAskText} onSend={onAskSend} />
    </div>
  );
}

// The Terminal tab of a session taken over, in one line (lane 36): who
// stopped it and when, and what Give back does; without the web terminal,
// why (here_only: not the loopback address). No command to run on the
// server: the terminal is the app's (owner request of 2026-10-22 17:26).
export function TakeoverNotice({ view, t, web = false, why }: { readonly view: SessionView; readonly t: Translate; readonly web?: boolean; readonly why?: 'here_only' | 'other' | undefined }) {
  const taken = takenOverOf(view);
  if (!taken || ENDED.has(phaseOf(view))) return null;
  const time = clock(taken.at);
  const mine = taken.by === view.me;
  return (
    <div className={web ? 'takeover web' : 'takeover'} role="note">
      <p className="takeover-line"><strong className="takeover-title">{mine ? t('takeover_title', { time }) : t('takeover_other_title', { time })}</strong>{mine ? <> <span className="takeover-body">{t('takeover_after')}</span></> : null}</p>
      {!web && why === 'here_only' ? <p className="takeover-body">{t('terminal_here_only')}</p> : null}
    </div>
  );
}

const SIGN: Readonly<Record<DiffLine['kind'], string>> = { same: ' ', add: '+', del: '−' };

export type EditorShown = { readonly file: SessionFile | null; readonly base: SessionFile | null; readonly error?: string };

// The Editor tab's editing (decision 33, lane 32): whether the file shown
// can be opened for editing, else why not; and once it is, the editor's
// state, whether the session changed the file meanwhile (stale), and
// whether the session is taken over (the session is then told at Give back).
export type EditorEdit = EditorHandlers & {
  readonly can: boolean;
  readonly why?: ReadOnlyWhy | undefined;
  readonly state?: EditorState | undefined;
  readonly stale?: boolean;
  readonly taken?: boolean;
  readonly generation?: number;                             // a new editor at each open and reload, not at each save
  readonly onEdit?: () => void;
};

// The Editor tab: the changed files, and the one picked, as its changes
// against the ticket's base or as the whole file; Edit opens it in the
// editor when it can be (lane 32), else the bar says why it is read only.
// The files as all the ticket's changes or as its last turn's (lane 36,
// Codex's "last turn"), with how many each holds.
export type EditorScope = { readonly value: Scope; readonly all: number; readonly last: number; readonly onScope?: (scope: Scope) => void };

export function EditorTab({ t, files, selected, shown, mode, failed = false, edit, scope, onSelect, onMode }: {
  readonly t: Translate; readonly files: SessionFiles['files']; readonly selected?: string | undefined; readonly shown?: EditorShown | undefined;
  readonly mode: 'diff' | 'file'; readonly failed?: boolean; readonly edit?: EditorEdit | undefined; readonly scope?: EditorScope | undefined;
  readonly onSelect?: (path: string) => void; readonly onMode?: (mode: 'diff' | 'file') => void;
}) {
  const editing = edit?.state;
  const held = editing !== undefined && (isDirty(editing) || editing.status === 'saving');
  const lines = shown?.file && !editing ? (mode === 'diff' ? lineDiff(shown.base?.text, shown.file.text) : fileLines(shown.file.text)) : [];
  const cut = shown?.file && !editing ? cutNote(shown.file, t) : undefined;
  const readOnly = edit?.why === undefined || edit.why === 'session' ? t('editor_read_only') : t(`editor_ro_${edit.why}`);
  return (
    <div className="editor">
      <nav className="editor-files" aria-label={t('editor_files')}>
        <h3 className="card-label">{t('editor_files')}</h3>
        {scope && scope.all > 0 ? (
          <div className="mode scope" role="group" aria-label={t('editor_scope')}>
            {(['all', 'last'] as const).map((value) => (
              <button key={value} type="button" data-scope={value} aria-pressed={scope.value === value} disabled={held || (value === 'last' && scope.last === 0)} onClick={() => scope.onScope?.(value)}>
                {t(`editor_scope_${value}`)} <span className="scope-n">{quantity(value === 'all' ? scope.all : scope.last, t)}</span>
              </button>
            ))}
          </div>
        ) : null}
        {files.length === 0 ? <p className="faint small">{t('changes_none')}</p> : (
          <ul>
            {files.map((file) => (
              <li key={file.path}>
                <button type="button" className="file-pick" data-file={file.path} disabled={held} aria-current={file.path === selected ? 'true' : undefined} onClick={() => onSelect?.(file.path)}>
                  <span className="path">{file.path}</span><span className="counts"><Counts added={file.added} removed={file.removed} t={t} /></span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {held ? <p className="faint small editor-wait">{t('editor_wait')}</p> : null}
      </nav>
      <div className="editor-view">
        {selected === undefined ? (files.length > 0 ? <p className="faint small">{t('editor_pick')}</p> : null) : (
          <>
            <div className="editor-bar">
              <span className="path">{selected}</span>
              {shown?.file && shown.base === null ? <span className="tag">{t('editor_new')}</span> : null}
              {editing ? null : (
                <div className="mode" role="group" aria-label={t('editor_mode')}>
                  <button type="button" aria-pressed={mode === 'diff'} onClick={() => onMode?.('diff')}>{t('editor_diff')}</button>
                  <button type="button" aria-pressed={mode === 'file'} onClick={() => onMode?.('file')}>{t('editor_file')}</button>
                </div>
              )}
              {editing ? null : edit?.can && shown?.file
                ? <Button className="btn edit-button" data-act="editor_edit" onClick={edit.onEdit}>{t('editor_edit')}</Button>
                : <span className="read-only">{readOnly}</span>}
            </div>
            {editing && edit ? <Editing key={`${editing.doc.path}:${edit.generation ?? 0}`} t={t} state={editing} taken={edit.taken ?? false} stale={edit.stale ?? false} path={editing.doc.path}
              onChange={edit.onChange} onSave={edit.onSave} onConfirm={edit.onConfirm} onReload={edit.onReload} onClose={edit.onClose} />
              : shown?.error !== undefined ? <p className="editor-note bad">{t('editor_refused', { reason: shown.error })}</p>
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
  return <div className="browser-empty"><Empty block icon={Browser} text={t(view.kind === 'here_only' ? 'browser_here_only' : 'screen_empty')} /></div>;
}
