// Milestone 4's proof, the mirrors' part (B6.4p, docs/v2/milestone-4-plan.md
// section 1), on the real ticket store and the real trackers' code over
// fakes of Linear and GitHub: a ticket created in the app appears on the
// tracker; an issue created there appears in the app; a person's move on
// the tracker wins over an agent's move in the app between two passes.
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { GitHubTracker } from '../../src/tickets/mirror-github.ts';
import { LinearTracker } from '../../src/tickets/mirror-linear.ts';
import { Mirror, type Tracker } from '../../src/tickets/mirror.ts';
import { AGENTS, Clock, HUMAN, openStore } from './mirror-support.ts';
import { FakeGitHub } from './fakes/github.ts';
import { FakeLinear } from './fakes/linear.ts';

const PROJECT = 'guestbook';

type Remote = {
  readonly tracker: Tracker;
  stateOf(id: string): string | undefined;
  personCreates(title: string, state: string): string;
  personMoves(id: string, state: string): void;
  close(): Promise<void>;
};

async function linear(clock: Clock): Promise<Remote> {
  const key = randomBytes(16).toString('hex');
  const fake = new FakeLinear({ clock: () => clock.iso, accounts: { [key]: { id: 'user-mirror', name: 'Cleared' } } });
  const api = await fake.listen();
  const jane = { user: { id: 'user-jane', name: 'Jane' } };
  return {
    tracker: new LinearTracker({ api, token: key, team: 'ENG' }),
    stateOf: (id) => fake.stateOf(id),
    personCreates: (title, state) => fake.create(jane, { title, state }).id,
    personMoves: (id, state) => fake.move(id, jane, state),
    close: () => fake.close(),
  };
}

async function github(clock: Clock): Promise<Remote> {
  const repo = 'org/guestbook';
  const jane = { login: 'jane', type: 'User' as const };
  const key = randomBytes(16).toString('hex');
  const fake = new FakeGitHub({ clock: () => clock.iso, accounts: { [key]: { login: 'cleared-bot', type: 'User' } }, repos: [repo] });
  const api = await fake.listen();
  return {
    tracker: new GitHubTracker({ api, token: key, repo, service: 'guestbook' }),
    stateOf: (id) => {
      const issue = fake.issue(repo, Number(id));
      if (issue.state === 'closed') return 'Done';
      return issue.labels.find((l) => l.name.startsWith('status:'))?.name.slice('status:'.length) ?? 'Todo';
    },
    personCreates: (title, state) => {
      const issue = fake.open(repo, jane, { title, labels: [`status:${state}`] });
      return String(issue.number);
    },
    personMoves: (id, state) => {
      if (state === 'Done') fake.close_(repo, Number(id), jane);
      else fake.status(repo, Number(id), jane, state);
    },
    close: () => fake.close(),
  };
}

for (const [name, make] of [['Linear', linear], ['GitHub Issues', github]] as const) {
  test(`B6.4p on ${name}: created in the app, appears there; created there, appears in the app; a person's move there wins`, async () => {
    const clock = new Clock();
    const { db, store } = openStore(clock);
    const remote = await make(clock);
    try {
      const mirror = new Mirror({ db, tickets: store, trackers: [remote.tracker], project: PROJECT, services: [], language: 'fr', now: clock.now, log: (line) => assert.fail(line) });
      await mirror.pass();

      // Step 1: a ticket created in the app appears on the tracker, in its state.
      clock.tick();
      const ticket = await store.create({ title: 'Newest entry first', project: PROJECT }, HUMAN);
      await store.move(ticket.id, 'In Progress', AGENTS);
      clock.tick(60);
      await mirror.pass();
      const link = db.prepare('SELECT issue FROM mirror_links WHERE ticket = ?').get(ticket.id) as { issue: string } | undefined;
      assert.ok(link, 'step 1: linked');
      assert.equal(remote.stateOf(link.issue), 'In Progress', 'step 1: in its state');

      // Step 2: an issue created on the tracker appears in the app.
      clock.tick();
      remote.personCreates('Show the entry count', 'Todo');
      clock.tick(60);
      await mirror.pass();
      const imported = (await store.list()).find((t) => t.title === 'Show the entry count');
      assert.equal(imported?.status, 'Todo', 'step 2');

      // Step 3: a person moves the issue while an agent moves the ticket, after the person.
      clock.tick();
      remote.personMoves(link.issue, 'Done');
      clock.tick(5);
      await store.move(ticket.id, 'In Review', AGENTS);
      clock.tick(60);
      await mirror.pass();
      assert.equal((await store.get(ticket.id))?.status, 'Done', 'step 3: the person wins in the app');
      assert.equal(remote.stateOf(link.issue), 'Done', 'step 3: and on the tracker');
      const rows = db.prepare("SELECT count(*) AS n FROM tracker_history WHERE proof IS NOT NULL AND actor_id <> 'demo'").get() as { n: number };
      assert.equal(rows.n, 0);
      const forged = db.prepare("SELECT count(*) AS n FROM tracker_history WHERE actor_id = 'cleared-mirror' AND (actor_kind <> 'agents' OR proof IS NOT NULL)").get() as { n: number };
      assert.equal(forged.n, 0, 'the mirror\'s rows are never a signed person\'s');
    } finally {
      await remote.close();
    }
  });
}
