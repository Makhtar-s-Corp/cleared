// The ready section's orphans line (issue #477, after issue 265): the
// volumes and networks labelled cleared.dev=v2 that no live session holds,
// listed with what to do, never removed. Live is read in the ledger, opened
// read only: a flow session whose row is stopped is not live even when one
// of its containers still runs (issue 265's case: an egress left running); a
// reader's row says done while it waits for a follow-up, and a session the
// ledger does not know (an environment check, the doctor's own probe,
// another install on the host) is live while one of its containers runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readyChecks } from '../../src/doctor/ready.ts';
import { findOrphans, readLedgerSessions, type LedgerSession } from '../../src/doctor/orphans.ts';
import type { DoctorLine } from '../../src/doctor/section.ts';
import { sessionNames } from '../../src/container/session-runtime.ts';
import { openStore } from '../../src/store/db.ts';
import type { FakeDocker } from '../container/fake-docker.ts';
import { install, type Install } from './support.ts';

const id = (n: number): string => `0b7f3c1e-5d0a-4a6e-9f3b-${String(n).padStart(12, '0')}`;
const WORKING = id(1);        // an author at work: live
const STOPPED = id(2);        // an author stopped, its egress still running (issue 265)
const READER_WAITING = id(3); // a reader done, waiting for a follow-up in its running container: live
const READER_GONE = id(4);    // a reader done, its containers gone
const CHECK = id(5);          // unknown to the ledger, a container running: an environment check, live
const STRAY = id(6);          // unknown to the ledger, nothing running
const LEAD = id(7);           // the lead at work: live

const AT = '2026-10-28T09:00:00.000Z';

function ledger(made: Install): string {
  const path = join(made.state, 'ledger.db');
  const store = openStore(path);
  const row = (session: string, role: 'author' | 'reviewer' | 'reader' | 'lead', status: string, ticket = 'GB-12') =>
    store.sessions.put({ id: session, project: 'guestbook', ticket, role, harness: 'claude-code', model: 'claude-opus-5-5', status, createdAt: AT, updatedAt: AT });
  row(WORKING, 'author', 'working');
  row(STOPPED, 'author', 'stopped', 'GB-7');
  row(READER_WAITING, 'reader', 'done', 'ask-1');
  row(READER_GONE, 'reader', 'done', 'ask-2');
  row(LEAD, 'lead', 'working', 'lead');
  store.close();
  return path;
}

function objects(docker: FakeDocker): void {
  const labels = (session: string) => ({ 'cleared.dev': 'v2', 'cleared.session': session });
  const net = (session: string) => {
    const names = sessionNames(session);
    docker.networks.push({ id: `${session}-n1`, name: names.network, labels: labels(session) }, { id: `${session}-n2`, name: names.outNetwork, labels: labels(session) });
  };
  const vol = (session: string) => docker.volumes.push({ id: sessionNames(session).volume, name: sessionNames(session).volume, labels: labels(session) });
  const run = (session: string, name = sessionNames(session).container) => docker.containers.push({ id: `${session}-c`, name, labels: labels(session), state: 'running' });
  for (const session of [WORKING, STOPPED, READER_WAITING, READER_GONE, CHECK, STRAY, LEAD]) { net(session); vol(session); }
  run(WORKING); run(STOPPED, sessionNames(STOPPED).egress); run(READER_WAITING); run(CHECK); run(LEAD);
  // Another program's network and volume: never listed, so never named.
  docker.networks.push({ id: 'foreign', name: 'bridge-of-another-program', labels: {} });
  docker.volumes.push({ id: 'foreign-v', name: 'data-of-another-program', labels: {} });
}

const orphansOf = (lines: readonly DoctorLine[]) => lines.filter((line) => line.id === 'orphans');
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

test('findOrphans: the ledger decides for its flow and lead rows, a running container for a reader and for what the ledger does not know', () => {
  const sessions = new Map<string, LedgerSession>([
    [WORKING, { ticket: 'GB-12', role: 'author', status: 'working' }],
    [STOPPED, { ticket: 'GB-7', role: 'author', status: 'stopped' }],
    [READER_WAITING, { ticket: 'ask-1', role: 'reader', status: 'done' }],
    [READER_GONE, { ticket: 'ask-2', role: 'reader', status: 'done' }],
    [LEAD, { ticket: 'lead', role: 'lead', status: 'working' }],
  ]);
  const row = (session: string, name: string) => ({ id: name, name, labels: { 'cleared.dev': 'v2', 'cleared.session': session } });
  const all = [WORKING, STOPPED, READER_WAITING, READER_GONE, CHECK, STRAY, LEAD];
  const running = [WORKING, STOPPED, READER_WAITING, CHECK, LEAD].map((session) => ({ ...row(session, `cleared-v2-${session}-x`), state: 'running' }));
  const found = findOrphans({
    containers: running,
    networks: [...all.map((session) => row(session, sessionNames(session).network)), { id: 'bare', name: 'cleared-v2-bare', labels: { 'cleared.dev': 'v2' } }],
    volumes: all.map((session) => ({ name: sessionNames(session).volume, labels: row(session, '').labels })),
    sessions,
  });
  assert.deepEqual(found.networks.map((o) => o.name), [STOPPED, READER_GONE, STRAY].map((s) => sessionNames(s).network).concat('cleared-v2-bare'));
  assert.deepEqual(found.kept.map((o) => [o.name, o.ticket]), [[sessionNames(STOPPED).volume, 'GB-7'], [sessionNames(READER_GONE).volume, 'ask-2']]);
  assert.deepEqual(found.unknown.map((o) => o.name), [sessionNames(STRAY).volume]);
});

test('cleared doctor lists the orphan networks and volumes as notices with what to do, and removes nothing; the ledger is read only', async () => {
  const made = install();
  const path = ledger(made);
  objects(made.docker);
  const before = digest(path);
  const counts = () => [made.docker.containers.length, made.docker.networks.length, made.docker.volumes.length];
  const had = counts();
  const lines = await readyChecks({ env: made.env, language: 'en', probes: made.probes() });
  const orphans = orphansOf(lines);
  assert.ok(orphans.length >= 2, JSON.stringify(orphans));
  for (const line of orphans) {
    assert.equal(line.level, 'notice', 'an orphan is said, never a failure');
    assert.ok(line.todo && line.todo.length > 20, `${line.text} says what to do`);
    assert.ok(!line.todo.includes('prune'), 'the hint never says prune');
  }
  const text = orphans.map((line) => `${line.text}\n${line.todo}`).join('\n');
  for (const session of [STOPPED, READER_GONE, STRAY]) {
    assert.ok(text.includes(sessionNames(session).network), `${session}'s network is listed`);
    assert.ok(text.includes(sessionNames(session).outNetwork), `${session}'s outbound network is listed`);
  }
  for (const session of [WORKING, READER_WAITING, CHECK, LEAD]) assert.ok(!text.includes(session), `${session} is live: not listed`);
  assert.ok(text.includes(`${sessionNames(STOPPED).volume} (GB-7)`), 'a volume the ledger knows is named with its ticket');
  assert.ok(text.includes(sessionNames(STRAY).volume));
  assert.ok(!text.includes('another-program'), 'nothing unlabelled');
  assert.deepEqual(counts(), had, 'nothing removed');
  const verbs = made.docker.calls.map((call) => call.args.slice(0, 2).join(' '));
  assert.ok(!verbs.some((verb) => /\brm\b|prune|create|stop|kill/.test(verb)), verbs.join('; '));
  assert.equal(digest(path), before, 'the ledger is not written');
});

test('in French too, with every word there; a long list says how many more', async () => {
  const made = install();
  ledger(made);
  objects(made.docker);
  for (let n = 20; n < 32; n++) {
    const names = sessionNames(id(n));
    made.docker.networks.push({ id: `extra-${n}`, name: names.network, labels: { 'cleared.dev': 'v2', 'cleared.session': id(n) } });
  }
  const [en, fr] = [await readyChecks({ env: made.env, language: 'en', probes: made.probes() }), await readyChecks({ env: made.env, language: 'fr', probes: made.probes() })];
  assert.equal(orphansOf(fr).length, orphansOf(en).length);
  for (const [a, b] of orphansOf(en).map((line, i) => [line, orphansOf(fr)[i]!] as const)) {
    assert.notEqual(a.text, b.text);
    assert.notEqual(a.todo, b.todo);
  }
  const all = JSON.stringify([...orphansOf(en), ...orphansOf(fr)]);
  assert.ok(!all.includes('⟦'), `no missing word: ${all}`);
  assert.ok(!all.includes('\u2014'), 'no em dash');
  const networks = orphansOf(en).find((line) => line.text.includes(sessionNames(STOPPED).network))!;
  assert.match(networks.text, /\b18\b/, 'the count of networks');
  assert.match(networks.text, /and \d+ more/);
  assert.match(orphansOf(fr).find((line) => line.text.includes(sessionNames(STOPPED).network))!.text, /et \d+ autres/);
});

test('with no ledger yet, nothing is made: every labelled object with no running container is listed as unknown to this install', async () => {
  const made = install();
  objects(made.docker);
  const path = join(made.state, 'ledger.db');
  const lines = await readyChecks({ env: made.env, language: 'en', probes: made.probes() });
  assert.ok(!existsSync(path), 'the doctor makes no ledger');
  const text = orphansOf(lines).map((line) => line.text).join('\n');
  assert.ok(text.includes(sessionNames(STRAY).network));
  assert.ok(!text.includes(sessionNames(WORKING).network), 'a session with a running container is live');
  assert.equal(readLedgerSessions(path), undefined);
});

test('nothing orphaned: one line, passed', async () => {
  const made = install();
  const lines = orphansOf(await readyChecks({ env: made.env, language: 'en', probes: made.probes() }));
  assert.deepEqual(lines.map((line) => line.level), ['ok']);
});

test('a ledger that cannot be read: a notice that says so, and no list', async () => {
  const made = install();
  objects(made.docker);
  writeFileSync(join(made.state, 'ledger.db'), 'not a database');
  const lines = orphansOf(await readyChecks({ env: made.env, language: 'en', probes: made.probes() }));
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.level, 'notice');
  assert.ok(lines[0]!.todo);
  assert.ok(!lines[0]!.text.includes(sessionNames(STRAY).network));
});
