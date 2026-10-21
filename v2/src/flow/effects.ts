// The flow's effects for real: what leaves the process. Each one is a
// thin call to the workspace modules of lane 5 or to the lock's own client;
// the flow's tests replace all of them (FlowEffects in engine.ts).
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBriefing, writeBriefing } from '../workspace/briefing.ts';
import { git, projectCheckout, ticketBranch, ticketCheckout } from '../workspace/checkout.ts';
import { captureHandover } from '../workspace/handover.ts';
import { forgeEnvironments, publish } from '../workspace/publish.ts';
import { parseConf, projectSettings, type FlowConfig } from './config.ts';
import type { FlowEffects } from './engine.ts';

// The repository's root, which holds release-request.mjs, the lock's client.
const CLEARED = fileURLToPath(new URL('../../../', import.meta.url));

export type EffectsOptions = {
  readonly env?: NodeJS.ProcessEnv;
  readonly releaseRequest?: string;       // the lock's client; release-request.mjs of the repository by default
  readonly requestTimeoutMs?: number;
};

export function realEffects(config: FlowConfig, options: EffectsOptions = {}): FlowEffects {
  const env = options.env ?? process.env;
  const baseRef = `refs/remotes/origin/${config.base}`;
  const forge = () => forgeEnvironments(config.projectDir, env);
  const refresh = async () => projectCheckout({ url: config.repoUrl, dir: config.projectDir, base: config.base, env: (await forge()).git });

  return {
    // The project's settings as committed at the base branch, as of the last refresh.
    async settings() {
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

    // `release-request.mjs request_release <ticket> <pr> --ask`, the
    // announcement on its stdin: the lock asks the human, at these heads.
    requestRelease(input) {
      const script = options.releaseRequest ?? join(CLEARED, 'release-request.mjs');
      return new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ['--no-warnings', script, 'request_release', input.ticket, String(input.pr), '--ask'], {
          env: { ...env, CLEARED_REPO: config.projectDir }, stdio: ['pipe', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-1000); });
        const limit = options.requestTimeoutMs ?? 60_000;
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, limit);
        child.on('error', (error) => { clearTimeout(timer); reject(error); });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (timedOut) reject(new Error(`the lock did not answer the release request within ${Math.round(limit / 1000)} seconds`));
          else if (code === 0) resolve();
          else reject(new Error(`the lock refused the release request (exit ${code}): ${stderr.trim() || 'no message'}`));
        });
        child.stdin.on('error', () => undefined);
        child.stdin.end(input.announcement);
      });
    },
  };
}
