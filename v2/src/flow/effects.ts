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
import type { ServiceConfig } from '../workspace/config.ts';
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

// A diff the release card reads is cut here: the flags need the files and
// their lines, not a whole generated folder.
const MAX_DIFF = 4 * 1024 * 1024;

export function realEffects(config: FlowConfig, options: EffectsOptions = {}): FlowEffects {
  const env = options.env ?? process.env;
  // The service a call is for: a service of a workspace of several, else the
  // one-service workspace's, which the milestone 1 fields name.
  const of = (service?: ServiceConfig) => service
    ? { dir: service.dir, url: service.url, base: service.base, repo: service.repo }
    : { dir: config.projectDir, url: config.repoUrl, base: config.base, repo: config.repo };
  const forge = (service?: ServiceConfig) => forgeEnvironments(of(service).dir, env);
  const refresh = async (service?: ServiceConfig) => {
    const { dir, url, base } = of(service);
    return projectCheckout({ url, dir, base, env: (await forge(service)).git });
  };

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
    // The service's settings as committed at its base branch, after a fetch.
    // Each service repository keeps its own .cleared/agents.conf (decision 18).
    async settings(service) {
      // Fetched first: on a fresh service the project is not cloned yet, and
      // a changed verdict phrase or host on the base is read as it is now.
      await refresh(service);
      const { dir, base } = of(service);
      const baseRef = `refs/remotes/origin/${base}`;
      const conf = await git(dir, ['show', `${baseRef}:.cleared/agents.conf`]);
      let scripts: string[] = [];
      try {
        const pkg = JSON.parse(await git(dir, ['show', `${baseRef}:package.json`])) as { scripts?: Record<string, unknown> };
        scripts = Object.keys(pkg.scripts ?? {});
      } catch { /* no package.json at the base: no script to run */ }
      return projectSettings(parseConf(conf), scripts);
    },

    async refreshProject(service) {
      await refresh(service);
    },

    // The author's first call clones or fetches the project; the reviewer
    // works in the checkout that exists. A service of a workspace of several
    // has its checkout under <workdirs>/<ticket>/<service>, on the same branch
    // as the ticket's other services.
    async prepareWorkdir({ ticket, role, service }) {
      if (role === 'author') await refresh(service);
      const { dir, base } = of(service);
      const workdir = service ? join(config.workdirRoot, ticket.id, service.name) : join(config.workdirRoot, ticket.id);
      await ticketCheckout({ project: dir, workdir, base, branch: ticketBranch(ticket.id) });
      const briefing = await readBriefing({ project: dir, env, role, ticket: { id: ticket.id, title: ticket.title, body: ticket.body } });
      await writeBriefing({ project: dir, base, workdir }, briefing);
      return { workdir, briefing };
    },

    async captureHandover(input) {
      return captureHandover({ project: config.projectDir, env, ...input });
    },

    async publish(input) {
      const environments = await forge(input.service);
      const { dir, base, repo } = of(input.service);
      return publish({
        project: dir, workdir: input.workdir, base, branch: input.branch, repo, ticket: input.ticket,
        report: input.report, gitEnv: environments.git, ghEnv: environments.gh,
      });
    },

    // gh exits 8 while a check is pending, and prints the list all the same.
    async prChecks(pr, service) {
      const { gh } = await forge(service);
      const { dir, repo } = of(service);
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile('gh', ['pr', 'checks', String(pr), '--repo', repo, '--json', 'bucket'], { cwd: dir, env: gh, timeout: 15_000, encoding: 'utf8' },
          (error, out) => (error && (error as { code?: unknown }).code !== 8 ? reject(error) : resolve(out)));
      });
      return checksOf(JSON.parse(stdout) as { bucket: string }[]);
    },

    // What the published head changes against the base, read in the
    // service's own checkout, where publish fetched the head: from their
    // merge base, as the pull request shows it.
    async changes({ head, service }) {
      if (!/^[0-9a-f]{40}$/.test(head)) throw new Error('not a commit');
      const { dir, base } = of(service);
      const range = `refs/remotes/origin/${base}...${head}`;
      const files = (await git(dir, ['diff', '--no-color', '--no-ext-diff', '--no-renames', '--name-only', range, '--'])).split('\n').filter(Boolean);
      const diff = (await git(dir, ['diff', '--no-color', '--no-ext-diff', '--no-renames', range, '--'])).slice(0, MAX_DIFF);
      return { files, diff };
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
