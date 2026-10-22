// The flow's effects for real: what leaves the process. Each one is a
// thin call to the workspace modules of lane 5 or to the lock's own client;
// the flow's tests replace all of them (FlowEffects in engine.ts).
import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readApprovalRecord } from '../approval/record.ts';
import { stateDirectory } from '../approval/service.ts';
import { readBriefing, writeBriefing } from '../workspace/briefing.ts';
import { git, projectCheckout, ticketBranch, ticketCheckout } from '../workspace/checkout.ts';
import { captureHandover } from '../workspace/handover.ts';
import { forgeEnvironments, publish } from '../workspace/publish.ts';
import { parseConf, projectSettings, type FlowConfig } from './config.ts';
import type { FlowEffects } from './engine.ts';

// The repository's root, which holds release-request.mjs, the lock's client.
const CLEARED = fileURLToPath(new URL('../../../', import.meta.url));

// What the release card says of a pull request's checks, from the buckets of
// `gh pr checks --json bucket`: one failed or cancelled check fails them,
// one still running (or none reported yet) keeps them pending.
export function checksOf(checks: readonly { readonly bucket: string }[]): 'pending' | 'passed' | 'failed' {
  if (checks.some((c) => c.bucket === 'fail' || c.bucket === 'cancel')) return 'failed';
  if (checks.length === 0 || checks.some((c) => c.bucket === 'pending')) return 'pending';
  return 'passed';
}

export type EffectsOptions = {
  readonly env?: NodeJS.ProcessEnv;
  readonly releaseRequest?: string;       // the lock's client; release-request.mjs of the repository by default
  readonly requestTimeoutMs?: number;
  readonly mergeTimeoutMs?: number;
};

export function realEffects(config: FlowConfig, options: EffectsOptions = {}): FlowEffects {
  const env = options.env ?? process.env;
  const baseRef = `refs/remotes/origin/${config.base}`;
  const forge = () => forgeEnvironments(config.projectDir, env);
  const refresh = async () => projectCheckout({ url: config.repoUrl, dir: config.projectDir, base: config.base, env: (await forge()).git });

  // Runs the lock's client with `args`, `input` on its stdin; its exit code
  // and the end of what it said on stderr.
  const lock = (args: readonly string[], input: string, limit: number, extra: NodeJS.ProcessEnv) =>
    new Promise<{ code: number | null; stderr: string; timedOut: boolean }>((resolve, reject) => {
      const script = options.releaseRequest ?? join(CLEARED, 'release-request.mjs');
      const child = spawn(process.execPath, ['--no-warnings', script, ...args], {
        env: { ...env, CLEARED_REPO: config.projectDir, ...extra }, stdio: ['pipe', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-1000); });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, limit);
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr, timedOut }); });
      child.stdin.on('error', () => undefined);
      child.stdin.end(input);
    });

  return {
    // The project's settings as committed at the base branch, after a fetch.
    async settings() {
      // Fetched first: on a fresh service the project is not cloned yet, and
      // a changed verdict phrase or host on the base is read as it is now.
      await refresh();
      const conf = await git(config.projectDir, ['show', `${baseRef}:.cleared/agents.conf`]);
      let scripts: string[] = [];
      try {
        const pkg = JSON.parse(await git(config.projectDir, ['show', `${baseRef}:package.json`])) as { scripts?: Record<string, unknown> };
        scripts = Object.keys(pkg.scripts ?? {});
      } catch { /* no package.json at the base: no script to run */ }
      return projectSettings(parseConf(conf), scripts);
    },

    async refreshProject() {
      await refresh();
    },

    // The author's first call clones or fetches the project; the reviewer
    // works in the checkout that exists.
    async prepareWorkdir({ ticket, role }) {
      if (role === 'author') await refresh();
      const workdir = join(config.workdirRoot, ticket.id);
      await ticketCheckout({ project: config.projectDir, workdir, base: config.base, branch: ticketBranch(ticket.id) });
      const briefing = await readBriefing({ project: config.projectDir, env, role, ticket: { id: ticket.id, title: ticket.title, body: ticket.body } });
      await writeBriefing({ project: config.projectDir, base: config.base, workdir }, briefing);
      return { workdir, briefing };
    },

    async captureHandover(input) {
      return captureHandover({ project: config.projectDir, env, ...input });
    },

    async publish(input) {
      const environments = await forge();
      return publish({
        project: config.projectDir, workdir: input.workdir, base: config.base, branch: input.branch, repo: config.repo, ticket: input.ticket,
        report: input.report, gitEnv: environments.git, ghEnv: environments.gh,
      });
    },

    // gh exits 8 while a check is pending, and prints the list all the same.
    async prChecks(pr) {
      const { gh } = await forge();
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile('gh', ['pr', 'checks', String(pr), '--repo', config.repo, '--json', 'bucket'], { cwd: config.projectDir, env: gh, timeout: 15_000, encoding: 'utf8' },
          (error, out) => (error && (error as { code?: unknown }).code !== 8 ? reject(error) : resolve(out)));
      });
      return checksOf(JSON.parse(stdout) as { bucket: string }[]);
    },

    // `release-request.mjs request_release <ticket> <pr> --ask`, the
    // announcement on its stdin: the lock asks the human, at these heads.
    // Then the request time the lock recorded for these versions
    // (<state>/validations/<ticket>.json, which ask-validation.sh writes).
    async requestRelease(input) {
      const limit = options.requestTimeoutMs ?? 60_000;
      const run = await lock(['request_release', input.ticket, String(input.pr), '--ask'], input.announcement, limit, {});
      if (run.timedOut) throw new Error(`the lock did not answer the release request within ${Math.round(limit / 1000)} seconds`);
      if (run.code !== 0) throw new Error(`the lock refused the release request (exit ${run.code}): ${run.stderr.trim() || 'no message'}`);
      const record = readApprovalRecord(stateDirectory(env), input.ticket);
      return record && record.versions.some((v) => v.pr === input.pr) ? { requestedAt: record.at } : {};
    },

    // `release-request.mjs request_release <ticket> <pr>`, without --ask:
    // the broker runs merge-pr.sh, which merges once every check holds. The
    // client's exit says what happened (release-request.mjs and
    // serve/release-broker.mjs): 0 merged; 5 not now (merge-pr.sh's 3 or 5,
    // or the broker busy with another release); 1 refused for good
    // (merge-pr.sh's 6); anything else, the broker could not be asked.
    // ORCH_FROM_QUEUE makes merge-pr.sh answer "not now" without writing
    // v1's merge-queue file, which no v1 wake reads any more: the flow's
    // tick is the queue.
    async mergeRelease(input) {
      const limit = options.mergeTimeoutMs ?? 15 * 60_000;
      const run = await lock(['request_release', input.ticket, String(input.pr)], input.announcement, limit, { ORCH_FROM_QUEUE: '1' });
      const said = run.stderr.trim().split('\n').at(-1)?.trim() ?? '';
      if (run.timedOut) return { outcome: 'unavailable', message: `the lock did not answer within ${Math.round(limit / 1000)} seconds` };
      const outcome = run.code === 0 ? 'merged' : run.code === 5 ? 'queued' : run.code === 1 ? 'refused' : 'unavailable';
      return { outcome, message: said };
    },
  };
}
