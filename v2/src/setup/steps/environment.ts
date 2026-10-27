// The assistant's environment step (docs/v2/milestone-5-plan.md, sections 1
// and 10, step 6, matrix C15): each service of the workspace with what its
// base branch holds (its .devcontainer, its install command) and its
// prepared image (container/prepared.ts), built here after the workspace is
// connected; later merges build again what they changed. Build starts the
// builds, one service after the other, and answers at once; the screen reads
// the view again until none runs. Once a service's image is ready, its
// declared check runs in it (flow/env-setup.ts checkPrepared). The builds
// and the checks count as the machine's time, and the step is done when
// every service has a ready image.
//
// The setup session (section 13, C4): a service with no .devcontainer, whose
// image did not build or whose check failed in it, is proposed a ticket of
// the environment template, which a person starts here; the flow builds its
// branch's image and runs the check before its review (flow/env-setup.ts).
//
//   GET  /api/setup/environment          -> EnvironmentView
//   POST /api/setup/environment/build    -> 202 EnvironmentView
//   POST /api/setup/environment/session  { service, title, body } -> SetupSessionAnswer
//   400 { error }: invalid, unknown_service
//   409 { error }: no_workspace, invalid_workspace, no_flow, restart
//
// Reading the view asks Docker nothing: the builds' records, the checks'
// and the services' base branches say it.
import { homedir } from 'node:os';
import { Docker } from '../../container/docker.ts';
import { PreparedError, PreparedImages, readRecord, stateDirOf, type PreparedInputs, type PreparedSource } from '../../container/prepared.ts';
import type { EnvironmentService, EnvironmentView, SetupSessionAnswer } from '../../container/types.ts';
import { FlowConfigError, loadFlowConfig, workspaceOf } from '../../flow/config.ts';
import { ENVIRONMENT_LABEL, checkPrepared, declaredCheck, readPreparedCheck } from '../../flow/env-setup.ts';
import { runtime } from '../../flow/runtime.ts';
import type { Registry } from '../../modules/registry.ts';
import { cleanText, secretValues } from '../../session/clean.ts';
import type { UserId } from '../../session/contract.ts';
import type { Ticket, TicketId, TicketStore } from '../../tickets/contract.ts';
import { answer, guarded, HttpError, readBody } from '../http.ts';
import type { SetupStep, StepDeps } from '../step.ts';

// What the step asks of the running flow: its project, the services of the
// workspace it read at start, its tickets, and a ticket's start.
export type SetupFlow = {
  readonly project: string;
  readonly services: readonly string[];
  readonly tickets: TicketStore;
  begin(ticket: TicketId, by: UserId): void;
};

const runtimeFlow = (registry: Registry): SetupFlow | undefined => {
  const engine = runtime.engine(registry);
  return engine && {
    project: engine.config.project, services: workspaceOf(engine.config).services.map((service) => service.name),
    tickets: engine.registry.ticketStore, begin: (ticket, by) => { void engine.begin(ticket, by); },
  };
};

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

// The open setup session of each service: a ticket of the environment
// template not done yet, on that service, or on the only one.
async function openSessions(flow: SetupFlow | undefined): Promise<Map<string, TicketId>> {
  const open = new Map<string, TicketId>();
  if (!flow) return open;
  const several = flow.services.length > 1;
  const list: readonly Ticket[] = await flow.tickets.list();
  for (const ticket of list) {
    if (!ticket.labels.includes(ENVIRONMENT_LABEL) || ticket.status === flow.tickets.states.done) continue;
    const names = ticket.services?.map((service) => service.name) ?? (several ? [] : flow.services.slice(0, 1));
    for (const name of names) if (!open.has(name)) open.set(name, ticket.id);
  }
  return open;
}

async function serviceView(images: PreparedImages, source: PreparedSource, queued: boolean, setupTicket: TicketId | null): Promise<EnvironmentService> {
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
  const declared = inputs ? await declaredCheck(source) : undefined;
  const checkCommand = declared ? declared.command.join(' ') : null;
  const ran = state === 'ready' ? readPreparedCheck(images.stateDir, source.service) : undefined;
  const check = ran && ran.hash === hash && ran.command === checkCommand ? { command: ran.command, passed: ran.passed, at: ran.at, ms: ran.ms, tail: ran.tail } : null;
  const proposal: EnvironmentService['proposal'] = state === 'failed' ? 'build_failed'
    : check && !check.passed ? 'check_failed'
      : inputs?.devcontainer === 'none' ? 'no_devcontainer' : null;
  return {
    name: source.service,
    readable: problem !== null || inputs !== undefined,
    devcontainer: inputs?.devcontainer ?? null,
    foreignImage: inputs?.devcontainer === 'image' && inputs.from !== images.baseImage ? inputs.from : null,
    install: inputs?.installText ?? null,
    state,
    image: state === 'ready' ? record?.tag ?? null : null,
    builtAt: state === 'ready' ? record?.builtAt ?? null : null,
    buildMs: state === 'ready' ? record?.buildMs ?? null : null,
    startedAt: state === 'building' ? record?.startedAt ?? null : null,
    error: state === 'failed' ? problem ?? record?.error ?? null : null,
    checkCommand, check, proposal, setupTicket,
  };
}

const TITLE_MAX = 200;
const BODY_MAX = 20_000;

export function environmentStep(
  made: (stateDir: string) => PreparedImages = (stateDir) => new PreparedImages({ docker: new Docker(), stateDir }),
  flowOf: (registry: Registry) => SetupFlow | undefined = runtimeFlow,
): SetupStep {
  return {
    id: 'environment',
    filled: true,
    skippable: true,
    routes: (deps) => {
      // The services one Build has not reached yet: said as building, so that
      // the screen waits for the whole run.
      const queued = new Set<string>();
      let running: Promise<void> | undefined;

      const view = async (registry: Registry): Promise<EnvironmentView> => {
        const list = sources(deps);
        const flow = flowOf(registry);
        const sessions = !flow ? 'no_flow' : list && list.some((source) => !flow.services.includes(source.service)) ? 'restart' : 'ready';
        if (!list) return { workspace: false, services: [], sessions };
        const images = made(stateDirOf(deps.env));
        const open = await openSessions(flow);
        const services: EnvironmentService[] = [];
        for (const source of list) services.push(await serviceView(images, source, queued.has(source.service), open.get(source.service) ?? null));
        return { workspace: true, services, sessions };
      };

      // The declared check in a ready image, unless it already passed on it.
      const check = async (images: PreparedImages, source: PreparedSource, ready: { readonly tag: string | null; readonly hash: string | null }): Promise<void> => {
        if (!ready.tag || !ready.hash) return;
        const declared = await declaredCheck(source);
        const last = readPreparedCheck(images.stateDir, source.service);
        if (!declared || (last?.passed && last.hash === ready.hash && last.command === declared.command.join(' '))) return;
        // Cleaned as the flow's texts are: the record reaches the browser.
        const servicePaths = [images.stateDir, deps.env.HOME ?? homedir()].filter((path) => path && path !== '/');
        const clean = (text: string) => cleanText(text, { secrets: secretValues(deps.env), servicePaths });
        await checkPrepared({ docker: images.docker, stateDir: images.stateDir, source, image: ready.tag, hash: ready.hash, declared, clean, now: deps.now });
      };

      const build = async (list: readonly PreparedSource[]): Promise<void> => {
        const images = made(stateDirOf(deps.env));
        const started = Date.now();
        let ready = 0;
        for (const source of list) {
          try {
            const record = await images.ensure(source);
            ready += 1;
            await check(images, source, record);
          } catch (error) {
            console.error(`cleared-v2: the prepared image of ${source.service} was not built or checked (${error instanceof Error ? error.message.split('\n')[0] : typeof error})`);
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
          handle: guarded(deps, async (context) => answer(context, 200, await view(context.registry))),
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
            answer(context, 202, await view(context.registry));
          }),
        },
        // A setup session for one service: a ticket of the environment
        // template, in Todo and started, as the tower's Create does; the
        // open one when there is one.
        {
          method: 'POST', path: '/api/setup/environment/session',
          handle: guarded(deps, async (context, user) => {
            const body = await readBody(context.request);
            const { service, title, body: text } = body;
            if (typeof service !== 'string' || typeof title !== 'string' || typeof text !== 'string' || !title.trim() || title.length > TITLE_MAX || text.length > BODY_MAX)
              throw new HttpError(400, 'invalid');
            const list = sources(deps);
            if (!list) throw new HttpError(409, 'no_workspace');
            if (!list.some((source) => source.service === service)) throw new HttpError(400, 'unknown_service');
            const flow = flowOf(context.registry);
            if (!flow) throw new HttpError(409, 'no_flow');
            // The flow read its workspace at start (issue #420): a service connected since is not its yet.
            if (!flow.services.includes(service)) throw new HttpError(409, 'restart');
            const open = (await openSessions(flow)).get(service);
            if (open) return answer(context, 200, { ticket: open, created: false } satisfies SetupSessionAnswer);
            const ticket = await flow.tickets.create({
              title: title.trim(), body: text, project: flow.project, labels: [ENVIRONMENT_LABEL],
              ...(flow.services.length > 1 ? { services: [service] } : {}),
            }, { kind: 'human', id: user.id });
            flow.begin(ticket.id, user.id);
            answer(context, 200, { ticket: ticket.id, created: true } satisfies SetupSessionAnswer);
          }),
        },
      ];
    },
  };
}

export default environmentStep();
