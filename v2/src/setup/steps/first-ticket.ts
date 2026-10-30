// The assistant's first-ticket step (docs/v2/milestone-5-plan.md, section
// 14, proof steps 9 and 10): a first ticket that changes one visible line
// of the project, its text kept here rather than in the Tower's templates,
// proposed with the service it targets; moved to Todo in one click, where
// the flow starts it as any ticket (author, its session plan's Go and the
// owner's approval in the inbox, review, the lock, the release watch); then
// followed to live. The step
// is done when the ticket is Done, at that moment: the machine's time is
// the sessions' (Todo to the approval asked) and the merge's (approved to
// Done), the rest is the person's.
//
//   GET  /api/setup/first-ticket?language=en|fr   -> FirstTicketView
//   POST /api/setup/first-ticket { service, language } -> FirstTicketView
//   400 { error }: unknown_service; 409: no_workspace, exists, unsigned
//   (another language, or none: the app's, CLEARED_V2_APP_LANGUAGE)
//
// The flow's engine is the runtime's (flow/runtime.ts), built once a
// workspace exists; the tests give theirs (firstTicketStep).
import type { DatabaseSync } from 'node:sqlite';
import type { Language } from '../../../app/src/catalog.ts';
import { languageOf } from '../../cli/cleared.ts';
import { workspaceOf } from '../../flow/config.ts';
import type { FlowEngine } from '../../flow/engine.ts';
import { runtime } from '../../flow/runtime.ts';
import type { Registry, RouteContext } from '../../modules/registry.ts';
import type { UserId } from '../../session/contract.ts';
import { TicketError, type StatusChange, type Ticket, type TicketStore } from '../../tickets/contract.ts';
import { answer, guarded, HttpError, readBody } from '../http.ts';
import type { SetupStep, StepDeps } from '../step.ts';
import type { FirstTicket, FirstTicketStage, FirstTicketView } from '../types.ts';

export const FIRST_TICKET_TABLE = `CREATE TABLE IF NOT EXISTS v2_setup_first_ticket (
  id INTEGER PRIMARY KEY CHECK (id = 1), ticket TEXT NOT NULL, service TEXT, created_at TEXT NOT NULL
)`;

// The ticket, in the person's language: a team's content stays in its language.
const TEMPLATE: Readonly<Record<Language, { readonly title: string; readonly body: string }>> = {
  en: {
    title: 'One line in the README: this project takes its changes through Cleared',
    body: [
      'The first ticket of the setup: a small change anyone can see, made the way every ticket is made.',
      'Add one line at the end of README.md, at the root of the repository:',
      'This project takes its changes through Cleared: an author, a reviewer, and the owner\'s approval.',
      'If the repository has no README.md, create one with the project\'s name as its heading, then this line. Change nothing else.',
    ].join('\n\n'),
  },
  fr: {
    title: 'Une ligne dans le README : ce projet passe ses changements par Cleared',
    body: [
      'Le premier ticket de l\'installation : un petit changement que tout le monde voit, fait comme tout ticket.',
      'Ajoutez une ligne à la fin de README.md, à la racine du dépôt :',
      'Ce projet passe ses changements par Cleared : un auteur, un relecteur et l\'approbation du propriétaire.',
      'Si le dépôt n\'a pas de README.md, créez-le avec le nom du projet en titre, puis cette ligne. Ne changez rien d\'autre.',
    ].join('\n\n'),
  },
};

type Kept = { ticket: string; service: string | null; created_at: string };

const keptOf = (db: DatabaseSync): Kept | undefined =>
  db.prepare('SELECT ticket, service, created_at FROM v2_setup_first_ticket WHERE id = 1 AND ticket != \'\'').get() as Kept | undefined;

function stageOf(status: string, states: TicketStore['states']): FirstTicketStage {
  switch (status) {
    case states.todo: return 'todo';
    case states.progress: return 'working';
    case states.review: return 'review';
    case states.validate: return 'approval';
    case states.go: return 'merging';
    case states.done: return 'live';
    default: return 'stopped';
  }
}

// The author's session plan that waits for its Go in the inbox, if one does
// (issue #446): the owner's gesture, as the approval is.
const waitingPlan = (engine: FlowEngine, ticket: string): string | undefined =>
  engine.inbox.items().find((item) => item.kind === 'session_plan' && item.state === 'waiting' && item.ticket === ticket)?.id;

// The ticket's pull request, for its link: on the release card once it waits
// for the approval, else from its number and its repository's address.
function pullRequestOf(engine: FlowEngine, ticket: Ticket): { readonly number: number; readonly url: string } | undefined {
  const release = engine.inbox.items().find((item) => item.kind === 'release' && item.ticket === ticket.id);
  if (release?.kind === 'release') return { number: release.pr.number, url: release.pr.url };
  const part = ticket.services?.find((service) => service.pr !== null);
  const service = part && workspaceOf(engine.config).services.find((known) => known.name === part.name);
  if (!part?.pr || !service) return undefined;
  const home = service.url.replace(/\.git$/, '');
  return { number: part.pr, url: `${home}/${/gitlab/i.test(new URL(home).host) ? '-/merge_requests' : 'pull'}/${part.pr}` };
}

const ms = (from: string | undefined, to: string | undefined): number =>
  from && to ? Math.max(0, Date.parse(to) - Date.parse(from)) : 0;

// The machine's part of a ticket that went live: Todo to the first approval
// asked (the sessions), and the owner's approval to Done (the lock, the watch).
function machineOf(history: readonly StatusChange[], states: TicketStore['states']): number {
  const created = history[0]?.at;
  const asked = history.find((change) => change.status === states.validate)?.at;
  const approved = history.filter((change) => change.status === states.go && change.by.kind === 'human').at(-1)?.at;
  const live = history.filter((change) => change.status === states.done).at(-1)?.at;
  return ms(created, asked ?? approved) + ms(approved, live);
}

const rolledBack = (history: readonly StatusChange[], states: TicketStore['states']): boolean => {
  const approved = history.findIndex((change) => change.status === states.go);
  return approved >= 0 && history.slice(approved + 1).some((change) => change.status === states.todo);
};

function languageAsked(value: unknown, env: NodeJS.ProcessEnv): Language {
  return value === 'en' || value === 'fr' ? value : languageOf(env);
}

export function firstTicketStep(options: { readonly engine: (registry: Registry) => FlowEngine | undefined } = { engine: (registry) => runtime.engine(registry) }): SetupStep {
  // Where the ticket stands, and, once it is live, the step's record.
  async function ticketOf(deps: StepDeps, engine: FlowEngine | undefined): Promise<FirstTicket | null> {
    const kept = keptOf(deps.db);
    if (!kept) return null;
    const tickets = engine?.registry.ticketStore;
    const ticket: Ticket | undefined = await tickets?.get(kept.ticket).catch(() => undefined);
    if (!tickets || !ticket) return { id: kept.ticket, title: '', service: kept.service, stage: 'stopped', createdAt: kept.created_at, rolledBack: false };
    const history = await tickets.history(ticket.id);
    let stage = stageOf(ticket.status, tickets.states);
    const plan = stage === 'working' && engine ? waitingPlan(engine, ticket.id) : undefined;
    if (plan) stage = 'plan';
    if (stage === 'live' && !deps.records.get('first-ticket')?.doneAt) {
      deps.records.machine('first-ticket', machineOf(history, tickets.states));
      deps.records.done('first-ticket', history.filter((change) => change.status === tickets.states.done).at(-1)?.at ?? deps.now().toISOString());
    }
    const pullRequest = engine ? pullRequestOf(engine, ticket) : undefined;
    return { id: ticket.id, title: ticket.title, service: kept.service, stage, createdAt: kept.created_at, rolledBack: rolledBack(history, tickets.states), ...(plan ? { plan } : {}), ...(pullRequest ? { pullRequest } : {}) };
  }

  async function viewOf(deps: StepDeps, context: RouteContext, language: Language): Promise<FirstTicketView> {
    const engine = options.engine(context.registry);
    return {
      ready: engine !== undefined,
      services: engine ? workspaceOf(engine.config).services.map((service) => service.name) : [],
      proposal: TEMPLATE[language],
      ticket: await ticketOf(deps, engine),
    };
  }

  return {
    id: 'first-ticket',
    filled: true,
    skippable: true,
    tables: [FIRST_TICKET_TABLE],
    routes: (deps) => [
      {
        method: 'GET', path: '/api/setup/first-ticket',
        handle: guarded(deps, async (context) => {
          const asked = new URL(context.request.url ?? '/', 'http://setup').searchParams.get('language');
          answer(context, 200, await viewOf(deps, context, languageAsked(asked, deps.env)));
        }),
      },
      {
        method: 'POST', path: '/api/setup/first-ticket',
        handle: guarded(deps, async (context, user) => {
          const body = await readBody(context.request);
          const language = languageAsked(body.language, deps.env);
          const service = body.service;
          if (typeof service !== 'string' || !service) throw new HttpError(400, 'unknown_service');
          const engine = options.engine(context.registry);
          if (!engine) throw new HttpError(409, 'no_workspace');
          if (!workspaceOf(engine.config).services.some((known) => known.name === service)) throw new HttpError(400, 'unknown_service');
          // One first ticket: the row is taken before the ticket is made, so two clicks make one.
          const at = deps.now().toISOString();
          try { deps.db.prepare('INSERT INTO v2_setup_first_ticket (id, ticket, service, created_at) VALUES (1, \'\', ?, ?)').run(service, at); }
          catch { throw new HttpError(409, 'exists'); }
          const { title, body: text } = TEMPLATE[language];
          let ticket: Ticket;
          try {
            ticket = await engine.registry.ticketStore.create({ title, body: text, project: engine.config.project, services: [service] }, { kind: 'human', id: user.id as UserId });
          } catch (error) {
            deps.db.prepare('DELETE FROM v2_setup_first_ticket WHERE id = 1').run();
            if (error instanceof TicketError) throw new HttpError(409, 'unsigned');
            throw error;
          }
          deps.db.prepare('UPDATE v2_setup_first_ticket SET ticket = ? WHERE id = 1').run(ticket.id);
          void engine.begin(ticket.id, user.id as UserId);
          answer(context, 200, await viewOf(deps, context, language));
        }),
      },
    ],
  };
}

export default firstTicketStep();
