// The assistant's workspace step (docs/v2/milestone-5-plan.md, section 9,
// decision 15): the repositories the forge credential reaches, one or
// several picked, cloned, the links between them proposed, and the
// workspace file written from what the person ticked (workspace/connect.ts).
// The Services screen's Connect opens it too. Each connected service says
// whether its base holds a .devcontainer: one without is proposed a setup
// session at the environment step (section 13, C4). The repositories are listed
// through the forge contract's GitHub adapter (gh, with the GH_TOKEN the
// forge step set); a list that cannot be had says why, never gh's words.
//
//   GET  /api/setup/workspace           -> WorkspaceView
//   POST /api/setup/workspace/propose   { repositories, whole? } -> WorkspaceProposal
//   POST /api/setup/workspace           { repositories, whole?, services, links, contracts } -> WorkspaceWritten
//   400 { error }: invalid, too_many, unknown_repository, changed, cycle, invalid_workspace;
//   409: environment (CLEARED_V2_WORKSPACE is the environment's), no_forge, busy, checkout_other;
//   502: unreachable (the forge), clone_failed; 503: no state folder
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasDevcontainer } from '../../flow/env-setup.ts';
import type { ForgeRepository } from '../../forge/contract.ts';
import { forgeFor } from '../../forge/index.ts';
import { confirm, ConnectError, listChoices, pick, propose, WORKSPACE_FILE } from '../../workspace/connect.ts';
import { parseConf } from '../../workspace/config.ts';
import type { ConnectedService, WorkspaceProposal, WorkspaceView, WorkspaceWritten } from '../../workspace/types.ts';
import { answer, guarded, HttpError, readBody } from '../http.ts';
import { readSettings, settingsPath, stateFolder } from '../settings.ts';
import type { SetupStep, StepDeps } from '../step.ts';

const STATUS: Readonly<Record<string, number>> = { environment: 409, no_forge: 409, busy: 409, checkout_other: 409, unreachable: 502, clone_failed: 502 };

const hasCredential = (env: NodeJS.ProcessEnv) => Boolean(env.GH_TOKEN || env.GITHUB_TOKEN);

function paths(deps: StepDeps): { readonly state: string; readonly settings: string } {
  const settings = settingsPath(deps.env);
  if (!settings) throw new HttpError(503, 'no state folder: set CLEARED_STATE_DIR');
  return { state: stateFolder(deps.env), settings };
}

async function listed(deps: StepDeps): Promise<{ readonly repositories: ForgeRepository[]; readonly archived: number }> {
  if (!hasCredential(deps.env)) throw new ConnectError('no_forge');
  try {
    return await listChoices(forgeFor('github', { dir: paths(deps).state, env: deps.env }));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.error(`cleared-v2: the workspace step could not list the repositories (${error instanceof Error ? error.message : typeof error})`);
    throw new ConnectError('unreachable');
  }
}

// What the assistant wrote, when the settings name its file, each service
// with whether its base holds a .devcontainer.
async function connectedOf(deps: StepDeps): Promise<WorkspaceView['connected']> {
  const at = paths(deps);
  const file = join(at.state, WORKSPACE_FILE);
  if (readSettings(at.settings).env.CLEARED_V2_WORKSPACE !== file || !existsSync(file)) return null;
  let sections: Record<string, Record<string, string>>;
  try { sections = parseConf(readFileSync(file, 'utf8')); } catch { return null; }
  const services: ConnectedService[] = [];
  for (const [section, keys] of Object.entries(sections)) {
    const name = /^service\s+(\S+)$/.exec(section)?.[1];
    if (!name) continue;
    const path = keys.path ?? null;
    const devcontainer = keys.dir && keys.base ? await hasDevcontainer({ dir: keys.dir, base: keys.base, path }) : null;
    services.push({ name, repo: keys.repository ?? '', path, devcontainer });
  }
  return { services, at: deps.records.get('workspace')?.doneAt ?? null };
}

async function view(deps: StepDeps): Promise<WorkspaceView> {
  if (deps.fromEnvironment.has('CLEARED_V2_WORKSPACE')) return { repositories: [], archived: 0, problem: null, connected: null, source: 'environment' };
  const connected = await connectedOf(deps);
  const source = connected ? 'assistant' : null;
  try {
    const { repositories, archived } = await listed(deps);
    return { repositories: repositories.map((r) => ({ repo: r.repo, private: r.private })), archived, problem: null, connected, source };
  } catch (error) {
    if (!(error instanceof ConnectError)) throw error;
    return { repositories: [], archived: 0, problem: error.message === 'no_forge' ? 'no_forge' : 'unreachable', connected, source };
  }
}

const workspace: SetupStep = {
  id: 'workspace',
  filled: true,
  skippable: true,
  routes: (deps) => {
    // One clone at a time: two proposals at once would fetch into the same folders.
    let busy = false;
    const work = async <T>(run: () => Promise<T>): Promise<T> => {
      if (deps.fromEnvironment.has('CLEARED_V2_WORKSPACE')) throw new HttpError(409, 'environment');
      if (busy) throw new HttpError(409, 'busy');
      busy = true;
      try {
        return await run();
      } catch (error) {
        if (error instanceof ConnectError) throw new HttpError(STATUS[error.message] ?? 400, error.message);
        throw error;
      } finally {
        busy = false;
      }
    };
    return [
      {
        method: 'GET', path: '/api/setup/workspace',
        handle: guarded(deps, async (context) => answer(context, 200, await view(deps))),
      },
      {
        method: 'POST', path: '/api/setup/workspace/propose',
        handle: guarded(deps, async (context) => {
          const body = await readBody(context.request);
          const proposal = await work(async () => {
            const repositories = pick((await listed(deps)).repositories, body.repositories);
            const started = Date.now();
            const made = await propose({ repositories, whole: body.whole, stateDir: paths(deps).state, env: deps.env });
            const machineMs = Date.now() - started;
            deps.records.machine('workspace', machineMs);
            return { ...made, machineMs } satisfies WorkspaceProposal;
          });
          answer(context, 200, proposal);
        }),
      },
      {
        method: 'POST', path: '/api/setup/workspace',
        handle: guarded(deps, async (context) => {
          const body = await readBody(context.request);
          const written = await work(async () => {
            const repositories = pick((await listed(deps)).repositories, body.repositories);
            const at = paths(deps);
            const started = Date.now();
            const done = await confirm({
              repositories, whole: body.whole, ticks: { services: body.services, links: body.links, contracts: body.contracts },
              stateDir: at.state, env: deps.env, authorModel: deps.env.CLEARED_V2_AUTHOR_MODEL || 'claude-opus-5-5', settings: at.settings,
            });
            deps.records.machine('workspace', Date.now() - started);
            deps.records.done('workspace');
            const read = new Map(((await connectedOf(deps))?.services ?? []).map((service) => [service.name, service.devcontainer]));
            return { ...done, services: done.services.map((service) => ({ ...service, devcontainer: read.get(service.name) ?? null })) } satisfies WorkspaceWritten;
          });
          answer(context, 200, written);
        }),
      },
    ];
  },
};

export default workspace;
