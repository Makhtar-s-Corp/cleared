// The tower's fixture: the data of tower.png that milestone 1 has, made by
// playing lane 1's fake adapter into an in-memory store, so that every
// session has real stored events. Names are neutral: the project is the
// example guestbook and tickets carry the local tracker's LOCAL-<n> ids;
// the titles and phrases are the capture's. The capture's plan card, the
// lead's message and the plan bar belong to milestone 2 and are left out.
import type { InboxItem, SessionSummary } from '../../src/api/types.ts';
import type { Harness, Role, SessionId } from '../../src/session/contract.ts';
import { createFakeAdapter, type FakeStep } from '../../src/session/adapters/fake.ts';
import type { SessionPhase, SessionState } from '../../src/session/events.ts';
import { DEFAULT_SAFE_COMMANDS } from '../../src/session/policy.ts';
import { openStore, type Store } from '../../src/store/db.ts';
import type { Ticket } from '../../src/tickets/contract.ts';
import type { TowerData } from '../public/screens/tower.ts';

export const FIXTURE_PROJECT = 'guestbook';

// The moment the tests read the fixture at: 09:41 local time, after both
// landings of the day (07:34 and 09:22).
export const FIXTURE_NOW = new Date(2026, 9, 21, 9, 41, 0);

type LiveSpec = {
  readonly ticket: string;
  readonly role: Role;
  readonly harness: Harness;
  readonly model: string;
  readonly minutes: number;
  readonly phase: SessionPhase;
  readonly status: string;
  readonly permission?: { readonly requestId: string; readonly command: string; readonly description: string; readonly reason: string };
};

const LIVE: readonly LiveSpec[] = [
  {
    ticket: 'LOCAL-161', role: 'author', harness: 'claude-code', model: 'claude-opus-5-5', minutes: 18, phase: 'waiting_human',
    status: 'Waiting for your permission to install date-fns',
    permission: { requestId: 'request-161', command: 'npm install date-fns', description: 'Install date-fns to group dates by week', reason: 'Network access and a new dependency.' },
  },
  { ticket: 'LOCAL-152', role: 'reviewer', harness: 'claude-code', model: 'claude-sonnet-5-5', minutes: 4, phase: 'reviewing', status: 'Reading the diff of src/screens/Envelope.jsx' },
  { ticket: 'LOCAL-160', role: 'author', harness: 'claude-code', model: 'claude-haiku-5-5', minutes: 2, phase: 'working', status: 'Running the docs tests · 12 passed so far' },
  { ticket: 'LOCAL-163', role: 'author', harness: 'codex', model: 'gpt-6-sol', minutes: 31, phase: 'working', status: 'Writing a test for a timeout on the bank API' },
];

const TITLES: Readonly<Record<string, string>> = {
  'LOCAL-158': '“Comings and goings” replaces “Departures and arrivals”',
  'LOCAL-161': 'Upcoming: group entries by week',
  'LOCAL-152': 'Envelope sheet shows its previous months',
  'LOCAL-160': 'Glossary: add the “Fast lane” entry',
  'LOCAL-163': 'Bank sync: retry once before failing',
};

const minutesBefore = (now: Date, minutes: number) => new Date(now.getTime() - minutes * 60_000);
const at = (now: Date, hours: number, minutes: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes);

function script(spec: LiveSpec, startedAt: Date): FakeStep[] {
  const state: SessionState = {
    status: spec.status, phase: spec.phase, steps: [{ name: spec.role === 'reviewer' ? 'review' : 'author', startedAt: startedAt.toISOString(), finishedAt: null }],
    files: [], checks: [], usage: {},
  };
  const steps: FakeStep[] = [
    { emit: { type: 'STEP_STARTED', stepName: spec.role === 'reviewer' ? 'review' : 'author' } },
    { emit: { type: 'RUN_STARTED', threadId: spec.ticket, runId: 'turn-1' } },
    { emit: { type: 'STATE_SNAPSHOT', snapshot: state } },
  ];
  if (spec.permission) {
    const { requestId, command, description, reason } = spec.permission;
    steps.push(
      { emit: { type: 'TOOL_CALL_START', toolCallId: 'run-1', toolCallName: 'Bash' } },
      { emit: { type: 'TOOL_CALL_ARGS', toolCallId: 'run-1', delta: JSON.stringify({ kind: 'execute', command, description }) } },
      { permission: { requestId, toolCallId: 'run-1', tool: 'Bash', input: { kind: 'execute', command, description }, suggestion: { decision: 'ask', rule: 'network', reason } } },
    );
  } else {
    steps.push({ awaitMessage: true });
  }
  return steps;
}

// The summary the service would answer for a session, from its stored events.
function summary(store: Store, id: SessionId, spec: LiveSpec, startedAt: Date, project: string): SessionSummary {
  const events = store.events.after(id);
  let status = '';
  let phase: SessionPhase = 'starting';
  for (const { event } of events) {
    if (event.type === 'STATE_SNAPSHOT') ({ status, phase } = event.snapshot);
  }
  const last = events[events.length - 1];
  return {
    id, project, ticket: spec.ticket, role: spec.role, harness: spec.harness, model: spec.model, phase, status,
    startedAt: startedAt.toISOString(), updatedAt: last?.at ?? startedAt.toISOString(), lastSeq: last?.seq ?? 0,
  };
}

export type TowerFixture = TowerData & { readonly store: Store };

export async function towerFixture(now: Date, options: { readonly project?: string } = {}): Promise<TowerFixture> {
  const project = options.project ?? FIXTURE_PROJECT;
  const store = openStore(':memory:');
  const sessions: SessionSummary[] = [];
  let next = 0;
  for (const spec of LIVE) {
    const startedAt = minutesBefore(now, spec.minutes);
    const adapter = createFakeAdapter({ log: store.events, script: script(spec, startedAt), harness: spec.harness, newId: () => `fixture-${++next}`, now: () => startedAt });
    const handle = await adapter.start({
      project, ticket: spec.ticket, role: spec.role, harness: spec.harness, model: spec.model, workdir: '/workspace', prompt: TITLES[spec.ticket] ?? spec.ticket,
      briefing: { projectPage: '', decisions: [], glossary: [], lessons: [], lastHandover: null },
      policy: { role: spec.role, base: 'main', workdir: '/workspace', scripts: ['test'], credentialFile: '/run/cleared/credential', safeCommands: DEFAULT_SAFE_COMMANDS, allowedHosts: [], forbiddenHosts: [], ticketFiles: [], learned: [] },
    });
    sessions.push(summary(store, handle.id, spec, startedAt, project));
  }

  const permission = LIVE[0] as LiveSpec & { permission: NonNullable<LiveSpec['permission']> };
  const inbox: InboxItem[] = [
    {
      kind: 'release', id: 'release-158', ticket: 'LOCAL-158', project, since: minutesBefore(now, 12).toISOString(), state: 'waiting',
      title: TITLES['LOCAL-158'] as string, announcement: 'The list of upcoming movements is now titled “Comings and goings”.',
      pr: { number: 42, url: 'https://example.invalid/guestbook/pull/42', checks: 'passed' }, heads: [{ pr: 42, head: '3f9c2a1d5e7b' }],
      requestedAt: minutesBefore(now, 12).toISOString(), captures: { before: { desktop: null, phone: null }, after: { desktop: null, phone: null } },
      sessions: [{ role: 'author', model: 'claude-opus-5-5', minutes: 34 }, { role: 'reviewer', model: 'claude-sonnet-5-5', minutes: 6, rounds: 1 }],
    },
    {
      kind: 'permission', id: 'permission-161', ticket: 'LOCAL-161', project, since: minutesBefore(now, 3).toISOString(), state: 'waiting',
      sessionId: sessions[0]?.id ?? '', requestId: permission.permission.requestId, tool: 'Bash',
      input: { kind: 'execute', command: permission.permission.command, description: permission.permission.description },
      suggestion: { decision: 'ask', rule: 'network', reason: permission.permission.reason },
    },
  ];

  const open = (id: string, status: string, minutes: number): Ticket => ({
    id, title: TITLES[id] as string, body: '', labels: [], project, status, createdAt: minutesBefore(now, minutes).toISOString(), updatedAt: now.toISOString(),
  });
  const landed = (id: string, title: string, doneAt: Date, minutes: number): Ticket => ({
    id, title, body: '', labels: [], project, status: 'Done', createdAt: minutesBefore(doneAt, minutes).toISOString(), updatedAt: doneAt.toISOString(),
  });
  const tickets: Ticket[] = [
    open('LOCAL-158', 'Needs Approval', 64),
    open('LOCAL-161', 'In Progress', 18),
    open('LOCAL-152', 'In Review', 40),
    open('LOCAL-160', 'In Progress', 2),
    open('LOCAL-163', 'In Progress', 31),
    landed('LOCAL-149', 'Stale figures no longer survive two crossing reads', at(now, 7, 34), 52),
    landed('LOCAL-151', 'The envelope list reads one section at a time', at(now, 9, 22), 38),
  ];
  return { sessions, inbox, tickets, store };
}
