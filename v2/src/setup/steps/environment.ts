// The assistant's environment step (docs/v2/milestone-5-plan.md, sections 1
// and 10, step 6, matrix C15): each service of the workspace with what its
// base branch holds (its .devcontainer, its install command) and its
// prepared image (container/prepared.ts), built here after the workspace is
// connected; later merges build again what they changed. Build starts the
// builds, one service after the other, and answers at once; the screen reads
// the view again until none runs. The builds count as the machine's time,
// and the step is done when every service has a ready image. Lane
// `v2-j5-env-setup` (section 13) adds the setup session's proposal for a
// service whose image cannot be built or has no .devcontainer.
//
//   GET  /api/setup/environment         -> EnvironmentView
//   POST /api/setup/environment/build   -> 202 EnvironmentView
//   409 { error }: no_workspace, invalid_workspace
//
// Reading the view asks Docker nothing: the builds' records and the
// services' base branches say it.
import { Docker } from '../../container/docker.ts';
import { PreparedError, PreparedImages, readRecord, stateDirOf, type PreparedInputs, type PreparedSource } from '../../container/prepared.ts';
import type { EnvironmentService, EnvironmentView } from '../../container/types.ts';
import { FlowConfigError, loadFlowConfig, workspaceOf } from '../../flow/config.ts';
import { answer, guarded, HttpError } from '../http.ts';
import type { SetupStep, StepDeps } from '../step.ts';

function sources(deps: StepDeps): PreparedSource[] | undefined {
  let config: ReturnType<typeof loadFlowConfig>;
  try {
    config = loadFlowConfig(deps.env);
  } catch (error) {
    if (error instanceof FlowConfigError) throw new HttpError(409, 'invalid_workspace');
    throw error;
  }
  return config ? workspaceOf(config).services.map((service) => ({ service: service.name, dir: service.dir, base: service.base, path: service.path })) : undefined;
}

async function serviceView(images: PreparedImages, source: PreparedSource, queued: boolean): Promise<EnvironmentService> {
  const record = readRecord(images.stateDir, source.service);
  let inputs: PreparedInputs | undefined;
  let problem: string | null = null;
  try {
    inputs = await images.readInputs(source);
  } catch (error) {
    if (!(error instanceof PreparedError)) throw error;
    problem = error.message;
  }
  const hash = inputs?.hash;
  const state: EnvironmentService['state'] = queued || images.building(source.service) ? 'building'
    : problem !== null || (record?.state === 'failed' && record.attempt === hash) ? 'failed'
      : record?.state === 'ready' && hash !== undefined && record.hash === hash ? 'ready'
        : record?.hash && hash !== undefined ? 'stale' : 'none';
  return {
    name: source.service,
    readable: problem !== null || inputs !== undefined,
    devcontainer: inputs?.devcontainer ?? null,
    install: inputs?.installText ?? null,
    state,
    image: state === 'ready' ? record?.tag ?? null : null,
    builtAt: state === 'ready' ? record?.builtAt ?? null : null,
    buildMs: state === 'ready' ? record?.buildMs ?? null : null,
    startedAt: state === 'building' ? record?.startedAt ?? null : null,
    error: state === 'failed' ? problem ?? record?.error ?? null : null,
  };
}

export function environmentStep(made: (stateDir: string) => PreparedImages = (stateDir) => new PreparedImages({ docker: new Docker(), stateDir })): SetupStep {
  return {
    id: 'environment',
    filled: true,
    skippable: true,
    routes: (deps) => {
      // The services one Build has not reached yet: said as building, so that
      // the screen waits for the whole run.
      const queued = new Set<string>();
      let running: Promise<void> | undefined;

      const view = async (): Promise<EnvironmentView> => {
        const list = sources(deps);
        if (!list) return { workspace: false, services: [] };
        const images = made(stateDirOf(deps.env));
        const services: EnvironmentService[] = [];
        for (const source of list) services.push(await serviceView(images, source, queued.has(source.service)));
        return { workspace: true, services };
      };

      const build = async (list: readonly PreparedSource[]): Promise<void> => {
        const images = made(stateDirOf(deps.env));
        const started = Date.now();
        let ready = 0;
        for (const source of list) {
          try {
            await images.ensure(source);
            ready += 1;
          } catch (error) {
            console.error(`cleared-v2: the prepared image of ${source.service} was not built (${error instanceof Error ? error.message.split('\n')[0] : typeof error})`);
          } finally {
            queued.delete(source.service);
          }
        }
        deps.records.machine('environment', Date.now() - started);
        if (ready === list.length) deps.records.done('environment');
      };

      return [
        {
          method: 'GET', path: '/api/setup/environment',
          handle: guarded(deps, async (context) => answer(context, 200, await view())),
        },
        {
          method: 'POST', path: '/api/setup/environment/build',
          handle: guarded(deps, async (context) => {
            const list = sources(deps);
            if (!list) throw new HttpError(409, 'no_workspace');
            if (!running) {
              for (const source of list) queued.add(source.service);
              running = build(list).finally(() => { running = undefined; });
            }
            answer(context, 202, await view());
          }),
        },
      ];
    },
  };
}

export default environmentStep();
