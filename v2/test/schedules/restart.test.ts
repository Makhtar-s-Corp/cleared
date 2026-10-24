// A service restarted with no browser open (P33, requirement C12): the
// scheduler starts with the service, as the flow's recovery does, and a
// schedule that came due while the service was down is taken at once, not
// when a route is first called nor a minute after the start. The service runs
// as its own process, the lead on the rehearsal's fake adapter, in a state
// folder of the temporary one; no request is made to it, only its ledger read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const main = new URL('../../src/main.ts', import.meta.url).pathname;

const IDLE_LEAD = { lead: { rules: [], otherwise: [{ say: 'Noted.' }], context: { start: 2, perTurn: 1 }, turnCostUsd: 0.01 }, author: { steps: [], file: { path: 'notes/{ticket}.md', text: 'x\n' } }, reviewer: [] };

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

test('a schedule due while the service was down runs after the restart with no request made, within seconds', async () => {
  const own = mkdtempSync(join(tmpdir(), 'cleared-v2-restart-'));
  const script = join(own, 'script.json');
  writeFileSync(script, JSON.stringify(IDLE_LEAD));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: own, CLEARED_STATE_DIR: own, CLEARED_V2_STATE_DIR: own, CLEARED_V2_PROJECT: 'guestbook', CLEARED_V2_PROJECT_DIR: join(own, 'checkout'),
    CLEARED_V2_REPO_URL: join(own, 'remote.git'), CLEARED_V2_REPO: 'example-org/guestbook', CLEARED_V2_QUOTA_MINUTES: '0',
    CLEARED_V2_ADAPTER: 'fake', CLEARED_V2_FAKE_SCRIPT: script,
  };
  const start = async (): Promise<ChildProcessWithoutNullStreams> => {
    const child = spawn(process.execPath, [main], { env: { ...env, CLEARED_V2_PORT: String(await freePort()) } });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const up = await Promise.race([once(child.stdout, 'data').then(() => true), once(child, 'exit').then(() => false)]);
    assert.ok(up, `the service did not start: ${stderr}`);
    return child;
  };
  const stop = async (child: ChildProcessWithoutNullStreams) => { child.kill('SIGTERM'); await once(child, 'exit'); };
  const path = join(own, 'ledger.db');
  const runs = (): number => {
    const db = new DatabaseSync(path, { readOnly: true });
    try { return Number((db.prepare("SELECT COUNT(*) AS n FROM schedule_runs WHERE schedule = 'sch-1'").get() as { n: number }).n); } finally { db.close(); }
  };
  try {
    await stop(await start());          // the first start creates the tables
    const write = new DatabaseSync(path);
    const past = new Date(Date.now() - 3600_000).toISOString();
    // A recipe the project does not have: the run fails and is recorded, which says the tick ran.
    write.prepare(`INSERT INTO schedules (id, project, recipe, goal, parameters, at, every, budget_usd, week_cap_percent, created_by, enabled, next_run_at, created_at)
      VALUES ('sch-1', 'guestbook', 'no-such-recipe', NULL, '{}', NULL, 'day 03:00', 1, 50, 'u1', 1, ?, ?)`).run(past, past);
    write.close();
    const second = await start();
    try {
      const end = Date.now() + 20_000;
      while (runs() === 0 && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(runs(), 1, 'the due schedule was taken once by the service itself, no request made');
    } finally {
      await stop(second);
    }
  } finally {
    rmSync(own, { recursive: true, force: true });
  }
});
