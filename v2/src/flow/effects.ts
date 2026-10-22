// The flow's effects for real: what leaves the process. Each one is a
// thin call to the workspace modules of lane 5 or to the lock's own client;
// the flow's tests replace all of them (FlowEffects in engine.ts).
import { execFile, spawn } from 'node:child_process';
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readApprovalRecord } from '../approval/record.ts';
import { stateDirectory } from '../approval/service.ts';
import { flatBriefing, levelContext, readLeveledBriefing, writeBriefing, type MemoryContext, type MemoryLevel } from '../workspace/briefing.ts';
import { git, projectCheckout, ticketBranch, ticketCheckout } from '../workspace/checkout.ts';
import { captureHandover } from '../workspace/handover.ts';
import { forgeEnvironments, publish } from '../workspace/publish.ts';
import type { ServiceConfig } from '../workspace/config.ts';
import type { Ticket } from '../tickets/contract.ts';
import { parseConf, projectSettings, workspaceOf, type FlowConfig } from './config.ts';
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

  // The memory levels (decision 25). The workspace's memory is milestone 1's,
  // read on the workspace's checkout (its first service's); a session's
  // service has its own level unless its checkout is that one, so a page is
  // never briefed twice; then the contracts it is briefed on: its service's
  // own, those of the services it consumes, then those of the ticket's other
  // services, each once.
  const workspace = workspaceOf(config);
  const memory: MemoryContext = { project: config.projectDir, env };
  const named = (name: string) => workspace.services.find((s) => s.name === name);
  const sessionService = (service?: ServiceConfig) => service ?? (workspace.services[0] as ServiceConfig);
  const providers = (own: ServiceConfig, ticket?: Ticket) => {
    const seen = new Set<string>();
    return [own, ...own.consumes.map(named), ...(ticket?.services ?? []).map((s) => named(s.name))]
      .filter((s): s is ServiceConfig => !!s?.contract && !seen.has(s.name) && !!seen.add(s.name));
  };
  // Where `## Lessons for the contract` goes: the service's own contract,
  // else the first one it consumes, as the briefing tells the author.
  const lessonContract = (own: ServiceConfig) => [own, ...own.consumes.map(named)].find((s): s is ServiceConfig => !!s?.contract);
  const serviceLevel = (own: ServiceConfig) => levelContext(memory, { kind: 'service', name: own.name, project: own.dir });
  const contractLevel = (provider: ServiceConfig) =>
    levelContext(memory, { kind: 'contract', name: provider.name, project: provider.dir, contract: provider.contract?.path as string });
  // A service whose checkout is the workspace's has no level of its own:
  // its page is the workspace's, and its lessons are filed there, so every
  // filed lesson is in a ledger a briefing reads.
  const ownLevel = (own: ServiceConfig) => (resolve(own.dir) === resolve(config.projectDir) ? undefined : serviceLevel(own));
  const levelsOf = (own: ServiceConfig, ticket: Ticket): MemoryLevel[] => {
    const level = ownLevel(own);
    return [...(level ? [level] : []), ...providers(own, ticket).map(contractLevel)];
  };
  // The service of a checkout <workdirs>/<ticket>/<service>, else the first.
  const serviceOfWorkdir = (workdir: string, ticket: string) => {
    const parts = relative(config.workdirRoot, workdir).split(sep);
    return (parts.length === 2 && parts[0] === ticket ? named(parts[1] as string) : undefined) ?? (workspace.services[0] as ServiceConfig);
  };

  // The ticket branch of a session's checkout, fetched as publish fetches a
  // branch: out of the checkout's .git into a private ref of the service's
  // own checkout, every object checked, so no git of the session's runs and
  // no hook either; a checkout whose .git is a link, a linked worktree or has
  // alternates is refused. The range from the service's base to that ref.
  const fetchBranch = async (ticket: string, service: ServiceConfig, workdir: string) => {
    const { dir, base } = of(service);
    const gitDir = join(workdir, '.git');
    if (!lstatSync(gitDir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`the ticket's checkout of ${service.name} has no .git folder of its own`);
    for (const parts of [['commondir'], ['objects', 'info', 'alternates']])
      if (lstatSync(join(gitDir, ...parts), { throwIfNoEntry: false })) throw new Error(`the ticket's checkout of ${service.name} cannot be read safely: .git/${parts.join('/')} is present`);
    const branch = ticketBranch(ticket);
    // Per service: two folder services of one repository share its checkout.
    const ref = `refs/cleared/step/${service.name}/${branch}`;
    await git(dir, ['-c', 'protocol.file.allow=always', '-c', 'transfer.fsckObjects=true', '-c', 'fetch.fsckObjects=true',
      'fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', gitDir, `+refs/heads/${branch}:${ref}`]);
    return { dir, ref, range: `refs/remotes/origin/${base}...${ref}` };
  };
  const DIFF_ARGS = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames'];

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
    // The author's call also fetches the providers of the contracts it is
    // briefed on, so a consumer's session reads the contract's page as its
    // base has it; a provider that cannot be fetched is left out of the
    // briefing, never in the way of the session.
    async prepareWorkdir({ ticket, role, service }) {
      if (role === 'author') await refresh(service);
      const { dir, base } = of(service);
      const workdir = service ? join(config.workdirRoot, ticket.id, service.name) : join(config.workdirRoot, ticket.id);
      await ticketCheckout({ project: dir, workdir, base, branch: ticketBranch(ticket.id) });
      const own = sessionService(service);
      // The workspace's memory reads the first service's checkout, which a
      // session on another service may be the first to need.
      if (role === 'author' && resolve(own.dir) !== resolve(config.projectDir)) await refresh().catch(() => undefined);
      if (role === 'author') for (const provider of providers(own, ticket)) if (provider.dir !== own.dir) await refresh(provider).catch(() => undefined);
      const read = await readLeveledBriefing({ ...memory, role, ticket: { id: ticket.id, title: ticket.title, body: ticket.body }, levels: levelsOf(own, ticket) });
      const lessons = workspace.services.length > 1 ? { service: ownLevel(own) ? own.name : null, contract: lessonContract(own)?.name ?? null } : undefined;
      await writeBriefing({ project: dir, base, workdir }, read.workspace, { levels: read.levels, ...(lessons ? { lessons } : {}) });
      return { workdir, briefing: flatBriefing(read) };
    },

    async captureHandover(input) {
      const own = serviceOfWorkdir(input.workdir, input.ticket);
      const level = ownLevel(own);
      const contract = lessonContract(own);
      return captureHandover({ ...memory, ...input, ...(level ? { service: level } : {}), ...(contract ? { contract: contractLevel(contract) } : {}) });
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

    // What a step's branch changes against the service's base (decision 26,
    // lane 23), read as publish reads a branch (fetchBranch). Only what is
    // committed counts. With `snapshot`, the contract as committed is
    // written into that folder, for the fakes of the steps after it, and
    // stays as it was validated whatever the branch does next.
    async stepChanges({ ticket, service, workdir, snapshot }) {
      const { dir, ref, range } = await fetchBranch(ticket, service, workdir);
      const files = (await git(dir, [...DIFF_ARGS, '--name-only', range, '--'])).split('\n').filter(Boolean);
      // The contract as a path of the repository, as the files are: a folder service's is inside its folder (release/order.ts).
      const path = service.contract ? (service.kind === 'folder' && service.path ? posix.join(service.path, service.contract.path) : service.contract.path) : undefined;
      if (!path) return { files, contract: null };
      const diff = (await git(dir, [...DIFF_ARGS, range, '--', path])).slice(0, MAX_DIFF);
      const blob = (await git(dir, ['rev-parse', '--verify', '--quiet', `${ref}:${path}`]).catch(() => '')).trim() || null;
      let copy: string | null = null;
      if (snapshot && blob) {
        mkdirSync(snapshot, { recursive: true, mode: 0o755 });
        copy = join(snapshot, basename(path));
        writeFileSync(copy, await git(dir, ['cat-file', 'blob', blob]), { mode: 0o644 });
      }
      return { files, contract: { path, diff, blob, snapshot: copy } };
    },

    // What a service's ticket branch changes, for the reviewer of a ticket
    // of several services (owner decision of 2026-10-22 20:33): read out of
    // <workdirs>/<ticket>/<service> as a step's branch is, committed changes
    // only; a service the ticket has no checkout of has none.
    async branchChanges({ ticket, service }) {
      const workdir = join(config.workdirRoot, ticket, service.name);
      if (!lstatSync(workdir, { throwIfNoEntry: false })) return { files: [], diff: '' };
      const { dir, range } = await fetchBranch(ticket, service, workdir);
      const files = (await git(dir, [...DIFF_ARGS, '--name-only', range, '--'])).split('\n').filter(Boolean);
      const diff = (await git(dir, [...DIFF_ARGS, range, '--'])).slice(0, MAX_DIFF);
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
