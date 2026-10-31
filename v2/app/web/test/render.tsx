// The components as HTML, for the tests: each screen's parts rendered with
// react-dom/server, under the names the HTML renderers had before the port,
// so the tests read as they did. Also the visible text of HTML, and every
// string of a value.
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { InboxItem, Plan } from '../../../src/api/types.ts';
import type { LeadMemory, LeadState } from '../../../src/api/types.ts';
import type { Translate } from '../lib/i18n.ts';
import type { PlanPanelOptions } from '../plan-panel/model.ts';
import { PlanPanel } from '../plan-panel/PlanPanel.tsx';
import { Actions, Detail, InboxScreen, List } from '../screens/inbox/Inbox.tsx';
import type { InboxView } from '../screens/inbox/model.ts';
import { LeadScreen, MemoryBody, Side, Thread } from '../screens/lead/Lead.tsx';
import type { LeadDraft, LeadView, SideOptions } from '../screens/lead/model.ts';
import { Composer, HandoverButton, LeftCards, RightCards, SessionIndex, StatusHead, ThreadFilter, Timeline } from '../screens/session/Session.tsx';
import { ActionCard, SessionHead } from '../screens/session/Glance.tsx';
import { pendingAction } from '../screens/session/glance.ts';
import { PlanGate } from '../screens/session/Tabs.tsx';
import type { SessionView } from '../screens/session/model.ts';
import type { Ticket } from '../../../src/tickets/contract.ts';
import type { SessionSummary } from '../../../src/api/types.ts';
import { Bar, TowerBody } from '../screens/tower/Tower.tsx';
import type { TowerModel } from '../screens/tower/model.ts';
import { Sidebar, type SidebarProps } from '../shell/Sidebar.tsx';
import type { ScreenName } from '../lib/routes.ts';
import { NotifyMenuBody } from '../shell/NotifyButton.tsx';
import type { NotifyView } from '../shell/notify.ts';

// The markup with what shadcn/ui's components add for Tailwind left out:
// their data-slot, and the utility classes of their variants, so a test
// reads the kit's classes (btn primary, plain, option...) as the sheets do.
const UTILITY = /^(?:[a-z-]+:.*|border-0|cursor-pointer|rounded-(?:md|full)|bg-(?:primary|card|transparent|\[var\(--surface\)\])|text-(?:primary-foreground|muted-foreground|link|xs)|font-\[var\(--weight-strong\)\]|shadow-control|\[box-shadow:var\(--e-[a-z]+\)\]|p-0|min-w-0|outline-none)$/;

// Also: attribute names in lower case and &#39; for an apostrophe, as HTML
// writes them and as the renderers did.
export function tidy(markup: string): string {
  return markup.replace(/ data-slot="[^"]*"/g, '').replace(/ ([a-z]+[A-Z][A-Za-z]*)=/g, (_, name: string) => ` ${name.toLowerCase()}=`).replace(/&#x27;/g, '&#39;').replace(/ class="([^"]*)"/g, (_, classes: string) => {
    const kept = classes.split(' ').filter((name) => name && !UTILITY.test(name));
    return kept.length ? ` class="${kept.join(' ')}"` : '';
  });
}

// A line of facts as components/facts/Facts.tsx draws it (lane j6-ui-hallmark): each fact a cell, a rule between.
export const factsHtml = (...facts: readonly string[]): string => facts.map((fact) => `<span class="fact">${fact}</span>`).join('<span class="fact-sep"><span class="sr-only">, </span></span>');

export const html = (node: ReactNode): string => tidy(renderToStaticMarkup(<>{node}</>));

// The text between tags, and the attributes a person reads or hears.
export function visibleText(markup: string): string[] {
  const out: string[] = [];
  for (const match of markup.matchAll(/\s(?:aria-label|title|placeholder|alt)="([^"]*)"/g)) out.push(match[1] ?? '');
  for (const run of markup.replace(/<[^>]*>/g, '\n').split('\n')) out.push(run);
  const runs = out.map((text) => text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").trim()).filter(Boolean);
  // A line of facts (components/facts/Facts.tsx, lane j6-ui-hallmark) is drawn as cells, its separator a rule that
  // says a comma to a screen reader: read back as the line the model joined, "a · b".
  const joined: string[] = [];
  for (let i = 0; i < runs.length; i += 1) {
    if (runs[i] === ',' && joined.length > 0 && i + 1 < runs.length) joined.push(`${joined.pop()} · ${runs[++i]}`);
    else joined.push(runs[i]!);
  }
  return joined;
}

export function strings(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') into.add(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, into);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) strings(item, into);
  return into;
}

// tower
export const renderBar = (t: Translate) => html(<><Bar t={t} title="" body="" /><p className="ask-note" id="ask-note" role="status" /></>);
export const renderTowerBody = (model: TowerModel, t: Translate) => html(<TowerBody model={model} t={t} />);
export const renderTower = (model: TowerModel, t: Translate) => `${renderBar(t)}<div id="tower-body">${renderTowerBody(model, t)}</div>`;

// session
export const renderStatus = (view: SessionView, t: Translate) => html(<StatusHead view={view} t={t} />);
export const renderTimeline = (view: SessionView, t: Translate) => html(<Timeline view={view} t={t} />);
export const renderLeft = (view: SessionView, t: Translate) => html(<LeftCards view={view} t={t} />);
export const renderRight = (view: SessionView, t: Translate) => html(<RightCards view={view} t={t} />);
export const renderComposer = (view: SessionView, t: Translate) => html(<Composer view={view} t={t} />);
export const renderFilter = (view: SessionView, t: Translate) => html(<ThreadFilter view={view} t={t} />);
// The one action of a view, as the screen draws it at its top; nothing when none is expected.
export function renderAction(view: SessionView, t: Translate): string {
  const action = pendingAction(view, []);
  if (!action) return '';
  return html(<ActionCard action={action} view={view} t={t} plan={action.kind === 'plan' ? <PlanGate plan={action.plan} t={t} /> : undefined} />);
}
export const renderSession = (view: SessionView, t: Translate) => `<div class="session">`
  + `${html(<SessionHead view={view} t={t} />)}${renderAction(view, t)}${renderComposer(view, t)}`
  + `<section class="panel"><div class="panel-head" id="detail-head">${renderStatus(view, t)}${html(<HandoverButton view={view} t={t} />)}</div>`
  + `${renderFilter(view, t)}<div class="timeline" id="timeline">${renderTimeline(view, t)}</div></section>`
  + `<div class="s-left" id="s-left">${renderLeft(view, t)}</div><div class="s-right" id="s-right">${renderRight(view, t)}</div></div>`;
export const renderIndex = (data: { readonly sessions: readonly SessionSummary[]; readonly tickets: readonly Ticket[]; readonly now: Date }, t: Translate) =>
  html(<SessionIndex sessions={data.sessions} tickets={data.tickets} now={data.now} t={t} />);

// lead
export const renderThread = (view: LeadView, t: Translate) => html(<Thread view={view} t={t} />);
export const renderMemory = (memory: LeadMemory, state: LeadState, now: Date, t: Translate, language: 'en' | 'fr' = 'en') => html(<MemoryBody memory={memory} state={state} now={now} t={t} language={language} />);
export const renderSide = (view: LeadView, t: Translate, options: SideOptions = {}) => html(<Side view={view} t={t} busy={options.busy ?? false} note={options.note ?? null} />);
export const renderLead = (view: LeadView, t: Translate, draft?: LeadDraft) => html(<LeadScreen view={view} t={t} {...(draft ? { draft } : {})} />);
export const renderPlanPanel = (plan: Plan, t: Translate, options: PlanPanelOptions = {}) => html(<PlanPanel plan={plan} t={t} options={options} />);

// inbox
export const renderList = (view: InboxView, t: Translate) => html(<List view={view} t={t} />);
export const renderDetail = (view: InboxView, t: Translate) => html(<Detail view={view} t={t} />);
export const renderActions = (item: InboxItem, view: InboxView, t: Translate) => html(<Actions item={item} view={view} t={t} />);
export const renderInbox = (view: InboxView, t: Translate, extra: { readonly handledOpen?: boolean } = {}) => html(<InboxScreen view={view} t={t} {...extra} />);

// shell
export const renderNotifyMenu = (view: NotifyView, t: Translate) => html(<NotifyMenuBody view={view} t={t} />);

// The shell's sidebar for a screen, before /api/me answers (no count, no dot).
export const renderSidebar = (screen: ScreenName, t: Translate, extra: Partial<SidebarProps> = {}) =>
  html(<Sidebar t={t} mode="open" screen={screen} project="Guestbook" userName="alex" source="service" me={null} waiting={null} lead="unknown" groups={[]} {...extra} />);
