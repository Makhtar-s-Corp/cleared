// The lead and plan screen (/lead, /plans/<id>): a stub until lane 8 of
// milestone 2 fills it against lead-and-plan.png. It reads what the tower
// bar sends (?draft= and ?goal=1) and keeps that text in a field the
// person can copy; nothing on it pretends to send, since the lead does not
// run yet. draftFrom, planFrom and renderLeadStub are pure, so the tests
// run them without a browser.
import { esc } from '../html.ts';
import type { Translate } from '../i18n.ts';
import type { ScreenContext } from '../screen.ts';

export type LeadDraft = { readonly text: string; readonly goal: boolean };

export const DRAFT_MAX = 2000;

// The tower bar's draft, from the page's query string.
export function draftFrom(search: string): LeadDraft {
  const query = new URLSearchParams(search);
  return { text: (query.get('draft') ?? '').slice(0, DRAFT_MAX), goal: query.get('goal') === '1' };
}

// The plan named by /plans/<id>, or null on /lead.
export function planFrom(path: string): string | null {
  return /^\/plans\/([A-Za-z0-9_-]{1,64})$/.exec(path)?.[1] ?? null;
}

export function renderLeadStub(draft: LeadDraft, plan: string | null, t: Translate): string {
  const kept = draft.text
    ? `<div class="lead-draft">
<label for="lead-draft">${esc(t(draft.goal ? 'lead_draft_goal' : 'lead_draft_message'))}</label>
<textarea id="lead-draft" rows="4" maxlength="${DRAFT_MAX}" aria-describedby="lead-draft-kept">${esc(draft.text)}</textarea>
<p class="faint small" id="lead-draft-kept">${esc(t('lead_draft_kept'))}</p>
</div>`
    : '';
  const planned = plan === null ? '' : `<section class="side-card" aria-labelledby="lead-plan-title"><h2 id="lead-plan-title">${esc(t('lead_plan'))}</h2><p class="faint small">${esc(t('lead_plan_later', { id: plan }))}</p></section>`;
  return `<div class="lead-stub">
<section class="side-card" aria-labelledby="lead-stub-title">
<div class="lead-head"><span class="lead-mark" aria-hidden="true">${esc(t('lead_initial'))}</span><h1 id="lead-stub-title">${esc(t('lead_heading'))}</h1></div>
<p class="note">${esc(t('lead_intro'))}</p>
${kept}
<p><a href="/">${esc(t('lead_back'))}</a></p>
</section>
${planned}
</div>`;
}

export function mount(root: HTMLElement, context: ScreenContext): () => void {
  root.innerHTML = renderLeadStub(draftFrom(location.search), planFrom(context.path), context.t);
  root.querySelector<HTMLTextAreaElement>('#lead-draft')?.focus();
  return () => {};
}
