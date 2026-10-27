// The assistant's workspace step as HTML (docs/v2/milestone-5-plan.md,
// section 9, lane v2-j5-connect): the repositories to pick, then the
// proposal: the services, a monorepo's two layouts, each contract and each
// link with the place that suggested it, none ticked for the person; the
// environment's file and an earlier connect said as such; and the Connect
// link of the Services screen. Every word from the catalogs, both languages.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { StepView } from '../../../../src/setup/types.ts';
import type { ServiceMap } from '../../../../src/api/types.ts';
import type { WorkspaceProposal, WorkspaceView } from '../../../../src/workspace/types.ts';
import type { Translate } from '../../lib/i18n.ts';
import { catalogOf } from '../../lib/catalogs.ts';
import { translator } from '../../lib/i18n.ts';
import { setupTranslator } from '../../screens/setup/model.ts';
import { WorkspaceStep } from '../../screens/setup/steps/Workspace.tsx';
import { ServicesFailed, ServicesView } from '../../screens/services/Services.tsx';
import { html, visibleText } from '../render.tsx';

const en = setupTranslator('en');
const fr = setupTranslator('fr');
const noop = () => undefined;
const api = { get: async () => ({ status: 200, body: {} }), post: async () => ({ status: 200, body: {} }) } as never;
const step: StepView = { id: 'workspace', state: 'todo', filled: true, skippable: true, shownAt: null, doneAt: null, skippedAt: null, personMs: 0, machineMs: 0 };
const each = (run: (t: Translate, language: 'en' | 'fr') => void) => { run(en, 'en'); run(fr, 'fr'); };
const noMark = (markup: string, what: string) => assert.doesNotMatch(markup, /⟦/, `${what}: no missing key`);

const VIEW: WorkspaceView = {
  repositories: [{ repo: 'example-org/both', private: true }, { repo: 'example-org/filter-api', private: false }, { repo: 'example-org/guestbook', private: false }],
  archived: 2, problem: null, connected: null, source: null,
};

const TWO: WorkspaceProposal = {
  repositories: [{ repo: 'example-org/guestbook', layout: 'whole', folders: [], from: null }, { repo: 'example-org/filter-api', layout: 'whole', folders: [], from: null }],
  services: [
    { name: 'guestbook', repo: 'example-org/guestbook', kind: 'repository', path: null, contract: null },
    { name: 'filter-api', repo: 'example-org/filter-api', kind: 'repository', path: null, contract: { format: 'openapi', path: 'contract/openapi.yaml' } },
  ],
  links: [{ id: 'guestbook>filter-api', from: 'guestbook', to: 'filter-api', items: ['POST /check'], places: [{ file: 'src/filter.ts', line: 38 }] }],
  machineMs: 3_400,
};

const MONO: WorkspaceProposal = {
  ...TWO,
  repositories: [{ repo: 'example-org/both', layout: 'folders', folders: ['filter-api', 'guestbook'], from: 'manifests' }],
  services: [
    { name: 'filter-api', repo: 'example-org/both', kind: 'folder', path: 'filter-api', contract: { format: 'openapi', path: 'contract/openapi.yaml' } },
    { name: 'guestbook', repo: 'example-org/both', kind: 'folder', path: 'guestbook', contract: null },
  ],
};

test('the list: one box per repository with its name, private ones said, the archived counted, and the button', () => {
  each((t, language) => {
    const markup = html(<WorkspaceStep t={t} step={step} api={api} onDone={noop} initial={{ view: VIEW }} />);
    noMark(markup, `list ${language}`);
    assert.match(markup, /data-workspace-step/);
    assert.equal(markup.match(/<input[^>]*type="checkbox"[^>]*name="repository"/g)?.length, 3);
    for (const repo of VIEW.repositories) assert.match(markup, new RegExp(`value="${repo.repo}"`));
    assert.match(markup, /<fieldset/);
    assert.match(markup, /<legend/);
    const text = visibleText(markup).join(' ');
    assert.match(text, language === 'en' ? /private/ : /privé/);
    assert.match(text, /2/, 'the archived ones counted');
    assert.match(markup, /data-act="setup_workspace_propose"/);
  });
});

test('no forge credential: the step says to connect GitHub first, with a link to that step', () => {
  each((t, language) => {
    const markup = html(<WorkspaceStep t={t} step={step} api={api} onDone={noop} initial={{ view: { ...VIEW, repositories: [], archived: 0, problem: 'no_forge' } }} />);
    noMark(markup, `no forge ${language}`);
    assert.match(markup, /data-workspace-problem="no_forge"/);
    assert.match(markup, /href="\/setup\/forge"/);
    assert.doesNotMatch(markup, /name="repository"/);
    const down = html(<WorkspaceStep t={t} step={step} api={api} onDone={noop} initial={{ view: { ...VIEW, repositories: [], archived: 0, problem: 'unreachable' } }} />);
    noMark(down, `unreachable ${language}`);
    assert.match(down, /data-workspace-problem="unreachable"/);
  });
});

test('the proposal: each service, its contract and the link with the place that suggested it, none of the lines ticked', () => {
  each((t, language) => {
    const markup = html(<WorkspaceStep t={t} step={step} api={api} onDone={noop} initial={{ view: VIEW, proposal: TWO, picked: ['example-org/guestbook', 'example-org/filter-api'] }} />);
    noMark(markup, `proposal ${language}`);
    assert.match(markup, /data-workspace-proposal/);
    assert.equal(markup.match(/name="service"[^>]*checked=""|checked=""[^>]*name="service"/g)?.length, 2, 'the services are kept unless the person unticks one');
    assert.match(markup, /name="contract"[^>]*value="filter-api"|value="filter-api"[^>]*name="contract"/);
    assert.match(markup, /name="link"[^>]*value="guestbook&gt;filter-api"|value="guestbook&gt;filter-api"[^>]*name="link"/);
    assert.doesNotMatch(markup, /name="(?:link|contract)"[^>]*checked|checked=""[^>]*name="(?:link|contract)"/, 'a proposed line is the person\'s to tick');
    const text = visibleText(markup).join(' ');
    assert.match(text, /guestbook/);
    assert.match(text, /POST \/check/);
    assert.match(text, /src\/filter\.ts/);
    assert.match(text, /38/);
    assert.match(text, /contract\/openapi\.yaml/);
    assert.match(text, /3\s?s/, 'the machine\'s time, as a person reads it');
    assert.doesNotMatch(text, /\d{4,} ?ms/);
    assert.match(markup, /data-act="setup_workspace_write"/);
  });
});

test('a monorepo: its folders as services or the repository as one, a choice of two', () => {
  each((t, language) => {
    const markup = html(<WorkspaceStep t={t} step={step} api={api} onDone={noop} initial={{ view: VIEW, proposal: MONO, picked: ['example-org/both'] }} />);
    noMark(markup, `monorepo ${language}`);
    assert.equal(markup.match(/type="radio"/g)?.length, 2);
    assert.match(markup, /value="folders"[^>]*checked|checked=""[^>]*value="folders"/);
    const text = visibleText(markup).join(' ');
    assert.match(text, /example-org\/both/);
    assert.match(text, /filter-api/);
  });
});

test('a connected service with no .devcontainer is said, with the step that proposes it a setup session; one with one, or unread, is not', () => {
  each((t, language) => {
    const services = [
      { name: 'guestbook', repo: 'example-org/guestbook', path: null, devcontainer: false },
      { name: 'filter-api', repo: 'example-org/filter-api', path: null, devcontainer: true },
      { name: 'jobs', repo: 'example-org/jobs', path: null, devcontainer: null },
    ];
    const one = html(<WorkspaceStep t={t} step={{ ...step, state: 'done' }} api={api} onDone={noop} initial={{ view: { ...VIEW, connected: { services, at: '2026-10-25T20:00:00.000Z' }, source: 'assistant' } }} />);
    noMark(one, `no devcontainer ${language}`);
    assert.match(one, /data-workspace-no-devcontainer/);
    const text = visibleText(one).join(' ');
    assert.ok(text.includes(t('workspace_no_devcontainer_one', { services: 'guestbook' })), `${language}: only the service without one`);
    assert.match(one, /<a class="setup-link" href="\/setup\/environment">/);
    const many = html(<WorkspaceStep t={t} step={{ ...step, state: 'done' }} api={api} onDone={noop} initial={{ view: { ...VIEW, connected: { services: services.map((s) => ({ ...s, devcontainer: false })), at: null }, source: 'assistant' } }} />);
    assert.ok(visibleText(many).join(' ').includes(t('workspace_no_devcontainer_many', { services: 'guestbook, filter-api, jobs' })));
    const none = html(<WorkspaceStep t={t} step={{ ...step, state: 'done' }} api={api} onDone={noop} initial={{ view: { ...VIEW, connected: { services: services.slice(1), at: null }, source: 'assistant' } }} />);
    assert.doesNotMatch(none, /data-workspace-no-devcontainer/);
  });
});

test('an earlier connect and the environment\'s file are said, the environment\'s with no way to replace it', () => {
  each((t, language) => {
    const done = html(<WorkspaceStep t={t} step={{ ...step, state: 'done' }} api={api} onDone={noop} initial={{ view: { ...VIEW, connected: { services: [{ name: 'guestbook', repo: 'example-org/guestbook', path: null }, { name: 'filter-api', repo: 'example-org/filter-api', path: null }], at: '2026-10-25T20:00:00.000Z' }, source: 'assistant' } }} />);
    noMark(done, `connected ${language}`);
    assert.match(done, /data-workspace-connected/);
    assert.match(visibleText(done).join(' '), /guestbook, filter-api/);
    assert.match(done, /data-act="setup_workspace_again"/);
    const environment = html(<WorkspaceStep t={t} step={step} api={api} onDone={noop} initial={{ view: { ...VIEW, source: 'environment' } }} />);
    noMark(environment, `environment ${language}`);
    assert.match(visibleText(environment).join(' '), /CLEARED_V2_WORKSPACE/);
    assert.doesNotMatch(environment, /name="repository"/);
  });
});

const MAP: ServiceMap = { workspace: 'guestbook', builtAt: null, readAt: null, services: [], databases: [], links: [], impact: {} };

test('the Services screen links to the workspace step, in its header and when no map can be read', () => {
  for (const language of ['en', 'fr'] as const) {
    const t = translator(catalogOf('services', language));
    const view = html(<ServicesView map={MAP} t={t} now={new Date('2026-10-25T20:00:00Z')} picked={null} />);
    noMark(view, `services ${language}`);
    assert.match(view, /<a[^>]*href="\/setup\/workspace"[^>]*data-act="services_connect"|data-act="services_connect"[^>]*href="\/setup\/workspace"/);
    const failed = html(<ServicesFailed t={t} message="no map" />);
    noMark(failed, `services failed ${language}`);
    assert.match(failed, /href="\/setup\/workspace"/);
    assert.match(visibleText(failed).join(' '), /no map/);
  }
});
