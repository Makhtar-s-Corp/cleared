// The assistant's first-ticket step's screen and the setup's summary
// (docs/v2/milestone-5-plan.md, section 14, lane v2-j5-first-ticket): the
// proposal with its service and the one button that moves it to Todo; the
// ticket followed stage by stage, the approval sent to the inbox; live with
// the summary of each step's time. Every word from the catalogs, in both
// languages, durations as a person reads them, never milliseconds.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { FirstTicketView, SetupView, StepView } from '../../../../src/setup/types.ts';
import { STEP_IDS } from '../../../../src/setup/types.ts';
import type { Translate } from '../../lib/i18n.ts';
import { setupTranslator } from '../../screens/setup/model.ts';
import { FirstTicketStep, SetupSummary } from '../../screens/setup/steps/FirstTicket.tsx';
import { html, visibleText } from '../render.tsx';

const en = setupTranslator('en');
const fr = setupTranslator('fr');
const each = (run: (t: Translate, language: 'en' | 'fr') => void) => { run(en, 'en'); run(fr, 'fr'); };
const noop = () => undefined;
const api = { get: async () => ({ status: 200, body: {} }), post: async () => ({ status: 200, body: {} }) } as never;
const noMark = (markup: string, what: string) => assert.doesNotMatch(markup, /⟦/, `${what}: no missing key`);
const noMs = (markup: string) => assert.doesNotMatch(visibleText(markup).join(' '), /\d{4,} ?ms|\bms\b/, 'no figure in milliseconds');

const STEP: StepView = { id: 'first-ticket', state: 'todo', filled: true, skippable: true, shownAt: null, doneAt: null, skippedAt: null, personMs: 0, machineMs: 0 };
const PROPOSAL = { title: 'One line in the README: the project takes its tickets through Cleared', body: 'Add one line at the end of README.md. Change nothing else.' };
const view = (over: Partial<FirstTicketView> = {}): FirstTicketView => ({ ready: true, services: ['web'], proposal: PROPOSAL, ticket: null, ...over });
const ticket = (stage: NonNullable<FirstTicketView['ticket']>['stage'], rolledBack = false): FirstTicketView['ticket'] => ({
  id: 'LOCAL-1', title: PROPOSAL.title, service: 'web', stage, createdAt: '2026-10-27T09:00:00.000Z', rolledBack,
});
const render = (t: Translate, initial: FirstTicketView) => html(<FirstTicketStep t={t} step={STEP} api={api} onDone={noop} initial={initial} />);

test('before a workspace: the step says to connect one, and links to its step, with nothing to move', () => {
  each((t, language) => {
    const markup = render(t, view({ ready: false, services: [] }));
    noMark(markup, `waiting ${language}`);
    assert.match(markup, /href="\/setup\/workspace"/);
    assert.doesNotMatch(markup, /data-act="first_ticket_move"/);
  });
});

test('the proposal: its title and its words as the ticket will carry them, the service named, one button to Todo', () => {
  each((t, language) => {
    const one = render(t, view());
    noMark(one, `proposal ${language}`);
    assert.match(one, /One line in the README/);
    assert.match(one, /Change nothing else/);
    assert.match(one, /web/);
    assert.equal(one.match(/data-act="first_ticket_move"/g)?.length, 1);
    assert.doesNotMatch(one, /<select/, 'one service: nothing to pick');
    const several = render(t, view({ services: ['web', 'api'] }));
    assert.match(several, /<label[^>]*for="first-ticket-service"/);
    assert.match(several, /<select[^>]*id="first-ticket-service"/);
    assert.match(several, /<option[^>]*>api<\/option>/);
  });
});

// The owner's request of 2026-10-30: no circle timeline, the real progress.
test('the ticket followed: where it stands in one sentence, its session live, the approval sent to the inbox', () => {
  each((t, language) => {
    const working = render(t, view({ ticket: ticket('working') }));
    noMark(working, `working ${language}`);
    assert.match(working, /LOCAL-1/);
    assert.doesNotMatch(working, /data-stage=|aria-current="step"/, 'no list of stages');
    assert.match(working, /data-setup-live=/);
    assert.match(working, /role="status"/);
    assert.doesNotMatch(working, /data-act="first_ticket_move"/);
    assert.ok(visibleText(working).join(' ').includes(t('first_ticket_now_working')));
    const approval = render(t, view({ ticket: ticket('approval') }));
    assert.match(approval, /href="\/inbox"/);
    const back = render(t, view({ ticket: ticket('todo', true) }));
    noMark(back, `rolled back ${language}`);
    assert.match(back, /data-rolled-back/);
    noMs(working);
  });
});

test('its pull request is a link once there is one', () => {
  each((t) => {
    const markup = render(t, view({ ticket: { ...ticket('review') as NonNullable<FirstTicketView['ticket']>, pullRequest: { number: 12, url: 'https://github.com/o/r/pull/12' } } }));
    assert.match(markup, /href="https:\/\/github\.com\/o\/r\/pull\/12"/);
  });
});

// Issue #446: the author's session plan waits for the person's Go in the
// inbox. The step says so and links to that item.
test('the plan waiting for its Go: said in words, and a link to the plan in the inbox', () => {
  each((t, language) => {
    const markup = render(t, view({ ticket: { ...ticket('plan') as NonNullable<FirstTicketView['ticket']>, plan: 'session_plan:s-1:1' } }));
    noMark(markup, `plan ${language}`);
    assert.match(markup, /data-first-ticket="plan"/);
    assert.match(markup, /href="\/inbox#session_plan%3As-1%3A1"/);
    assert.ok(visibleText(markup).join(' ').includes(t('first_ticket_now_plan')));
  });
});

test('the proposal says, in its fold, that the plan comes first and nothing ships without the person', () => {
  each((t) => {
    assert.ok(visibleText(render(t, view())).join(' ').includes(t('first_ticket_flow_note')));
  });
});

const steps: StepView[] = STEP_IDS.map((id, index) => ({
  ...STEP, id, state: id === 'secrets' ? 'skipped' : 'done', personMs: (index + 1) * 61_000, machineMs: id === 'environment' ? 7 * 60_000 : id === 'first-ticket' ? 11 * 60_000 : 0,
}));
const SETUP: SetupView = { steps, owner: 'alex', current: null, total: { personMs: steps.reduce((sum, s) => sum + s.personMs, 0), machineMs: 18 * 60_000 } };

test('the summary: a table of each step\'s time, the person\'s and the machine\'s, a skipped step said', () => {
  each((t, language) => {
    const markup = html(<SetupSummary t={t} view={SETUP} />);
    noMark(markup, `summary ${language}`);
    assert.match(markup, /<table/);
    assert.match(markup, /<caption/);
    assert.equal(markup.match(/<th scope="row"/g)?.length, STEP_IDS.length, 'a row per step');
    const text = visibleText(markup).join(' ');
    assert.match(text, language === 'en' ? /Skipped/ : /Passée/);
    noMs(markup);
  });
});

test('live: the step says so and shows the setup\'s summary', () => {
  each((t, language) => {
    const markup = html(<FirstTicketStep t={t} step={{ ...STEP, state: 'done' }} api={api} onDone={noop} initial={view({ ticket: ticket('live') })} summary={SETUP} />);
    noMark(markup, `live ${language}`);
    assert.ok(visibleText(markup).join(' ').includes(t('first_ticket_now_live')));
    assert.match(markup, /<details class="setup-detail">[\s\S]*<table/, 'the time per step, folded');
  });
});

// Issue #492: a step left open for days is not days of a person's work.
test('a step\'s time past an hour is said so, not as days', () => {
  const long = { ...SETUP, steps: SETUP.steps.map((s) => (s.id === 'forge' ? { ...s, personMs: (4 * 24 + 5) * 3_600_000 } : s)) };
  each((t) => {
    const text = visibleText(html(<SetupSummary t={t} view={long} />)).join(' ');
    assert.ok(text.includes(t('setup_time_long')));
    assert.doesNotMatch(text, /\d\s?(j|d)\b/);
  });
});
