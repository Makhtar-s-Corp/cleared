// Puts the lane's pieces together: the ticket store on the local tracker's
// tables, the approval writer with its grace, the review recorder. The modules
// (src/modules/tickets.ts and approval.ts) call this with what the
// environment says; the tests call it with what they choose.
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { SqliteUsers, proofPath, readOrCreateProof } from '../modules/users.ts';
import type { UserDirectory } from '../modules/registry.ts';
import { LocalTicketStore, TICKET_TABLES } from '../tickets/local-store.ts';
import type { TicketStates } from '../tickets/contract.ts';
import { ledgerPath } from '../store/db.ts';
import { SocketReleaseBroker, brokerSocketPath, type ReleaseBroker } from './broker.ts';
import { readLockConf, type LockConf } from './conf.ts';
import { ApprovalError } from './errors.ts';
import { readApprovalRecord, sameVersions, type Version } from './record.ts';
import { LedgerReviewRecorder, RUNS_TABLES, type ReviewRecorderOptions } from './review.ts';
import { ApprovalSigner, SigningKeyError } from './signer.ts';
import { LockApprovalWriter, type Timers } from './writer.ts';
import type { ApprovalRequest } from '../modules/registry.ts';
import type { MergeOutcome, ServiceLock } from '../release/lock.ts';
import { TrainStore, type Train } from '../release/store.ts';
import type { Ticket } from '../tickets/contract.ts';
import type { ServiceConfig, WorkspaceConfig } from '../workspace/config.ts';

// The tables the approval writer and the review recorder use besides the
// tickets': the ledger's runs and events, as lib/ledger.mjs creates them.
export const APPROVAL_TABLES: string[] = [...RUNS_TABLES];
export { TICKET_TABLES };

export type ApprovalOptions = {
  readonly db: DatabaseSync;
  readonly users: UserDirectory;
  readonly stateDir: string;
  readonly proof: string;
  readonly ownerId?: string | undefined;
  readonly publicKey?: string | undefined;
  readonly signer?: ApprovalSigner | undefined;
  readonly states?: TicketStates;
  readonly verdict?: string | undefined;
  readonly broker?: ReleaseBroker | null;
  readonly timers?: Timers;
  readonly graceMs?: number;
  readonly now?: () => Date;
  readonly announce?: (ticket: Ticket, by: string) => string;
  readonly resolveHead?: ReviewRecorderOptions['resolveHead'];
};

export function createApproval(options: ApprovalOptions) {
  const now = options.now ?? (() => new Date());
  const ticketStore = new LocalTicketStore(options.db, {
    stateDir: options.stateDir, users: options.users, now: () => now().toISOString(),
    ...(options.states ? { states: options.states } : {}), ...(options.ownerId ? { ownerId: options.ownerId } : {}),
    ...(options.publicKey ? { publicKey: options.publicKey } : {}), ...(options.signer ? { signer: options.signer } : {}),
  });
  const approvalWriter = new LockApprovalWriter({
    store: ticketStore, db: options.db, users: options.users, proof: options.proof, ownerId: options.ownerId, now,
    broker: options.broker ?? null, ...(options.timers ? { timers: options.timers } : {}),
    ...(options.graceMs !== undefined ? { graceMs: options.graceMs } : {}), ...(options.announce ? { announce: options.announce } : {}),
  });
  const reviewRecorder = new LedgerReviewRecorder(options.db, {
    stateDir: options.stateDir, verdict: options.verdict ?? '', ...(options.resolveHead ? { resolveHead: options.resolveHead } : {}),
  });
  return { ticketStore, approvalWriter, reviewRecorder };
}

const run = promisify(execFile);

// The head of a pull request now, from the forge, in the project's checkout:
// the fallback of the review recorder when the flow does not pass the commit.
function ghHead(project: string | undefined) {
  return async (pr: number): Promise<string | undefined> => {
    if (!project) return undefined;
    try {
      const { stdout } = await run('gh', ['pr', 'view', String(pr), '--json', 'headRefOid'], { cwd: project, timeout: 15_000, encoding: 'utf8' });
      return (JSON.parse(stdout) as { headRefOid?: string }).headRefOid;
    } catch {
      return undefined;
    }
  };
}

export function stateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLEARED_STATE_DIR || env.ORCH_STATE_DIR || dirname(ledgerPath(env));
}

export type Environment = ReturnType<typeof createApproval> & {
  readonly conf: LockConf;
  readonly signer: ApprovalSigner | undefined;
  readonly stateDir: string;
  readonly users: UserDirectory;
  readonly proof: string;
};

const environments = new WeakMap<DatabaseSync, Environment>();

// One set of pieces per database, for the tickets module and the approval
// module, which fill different slots of the registry from the same writer
// and store. What the environment lacks leaves the pieces working without
// approval: agents can write tickets, a human write or an approval is refused
// with a message that says what to run.
export function approvalEnvironment(db: DatabaseSync, env: NodeJS.ProcessEnv = process.env): Environment {
  const known = environments.get(db);
  if (known) return known;
  const conf = readLockConf(env);
  const stateDir = stateDirectory(env);
  let signer: ApprovalSigner | undefined;
  const keyFile = conf.privateKeyFile || env.CLEARED_V2_APPROVAL_KEY || join(stateDir, 'approval.key');
  try {
    signer = ApprovalSigner.load(keyFile);
  } catch (error) {
    if (error instanceof SigningKeyError && !/ENOENT/.test(error.message)) console.error(`cleared-v2: ${error.message}`);
    else console.error(`cleared-v2: no approval signing key at ${keyFile}: approvals are refused until \`npm run setup\` makes one`);
  }
  if (signer && conf.publicKey && signer.publicKey !== conf.publicKey)
    console.error('cleared-v2: the signing key is not the one [tracker] human_public_key names: the lock will not read the approvals as the owner\'s');
  let proof: string;
  try {
    proof = readOrCreateProof(proofPath(ledgerPath(env)));
  } catch (error) {
    console.error(`cleared-v2: ${(error as Error).message}: no request of the app is accepted`);
    proof = '';
  }
  const socket = brokerSocketPath({ env, confSocket: conf.socketPath, stateDir });
  const users = new SqliteUsers(db);
  const parts = createApproval({
    db, users, stateDir, proof, ownerId: conf.ownerId, publicKey: conf.publicKey, signer, states: conf.states, verdict: conf.verdict,
    broker: new SocketReleaseBroker(socket, { stateDir }), resolveHead: ghHead(env.CLEARED_REPO || env.ORCH_REPO),
  });
  const built: Environment = { ...parts, conf, signer, stateDir, users, proof };
  environments.set(db, built);
  return built;
}

// ---------------------------------------------------------------- the lock of each service (decision 21)

// Where each service's broker listens and keeps its state: the workspace
// file's broker_socket and broker_state, else the milestone 1 socket and
// state folder. Two services on one socket or one state folder are refused:
// a broker rewrites its secret at start, and two in one folder would
// overwrite each other's secret, merge.lock and validations.
export function lockPaths(workspace: WorkspaceConfig, env: NodeJS.ProcessEnv = process.env): Map<string, { readonly socket: string; readonly stateDir: string }> {
  const conf = readLockConf(env);
  const out = new Map<string, { socket: string; stateDir: string }>();
  for (const service of workspace.services) {
    const state = service.brokerState ?? stateDirectory(env);
    const socket = service.brokerSocket ?? brokerSocketPath({ env, confSocket: conf.socketPath, stateDir: state });
    for (const [other, paths] of out) {
      if (paths.stateDir === state) throw new Error(`the services ${other} and ${service.name} name the same broker state folder: give each its own broker_state`);
      if (paths.socket === socket) throw new Error(`the services ${other} and ${service.name} name the same broker socket: give each its own broker_socket`);
    }
    out.set(service.name, { socket, stateDir: state });
  }
  return out;
}

const outcomeOf = (answer: { ok: boolean; code?: number; definitive?: boolean; reason: string; output: string }): MergeOutcome => {
  const message = (answer.reason || answer.output).trim().split('\n').at(-1)?.trim() ?? '';
  if (answer.ok) return { outcome: 'merged', message };
  if (answer.code === 5) return { outcome: 'queued', message };
  if (answer.code === 1 && answer.definitive === true) return { outcome: 'refused', message };
  return { outcome: 'unavailable', message };
};

type Broker = Pick<SocketReleaseBroker, 'requestApproval' | 'requestRelease' | 'requestRollback'>;

export type ServiceLockOptions = {
  readonly env?: NodeJS.ProcessEnv;
  readonly environment?: Environment;                                // the signing pieces; approvalEnvironment(db, env) when absent
  readonly broker?: (paths: { readonly socket: string; readonly stateDir: string }) => Broker;
  readonly now?: () => Date;
};

// The ticket store of one service's state folder: the same ledger and the
// same signer, its validations record. Its recordApproval signs the owner's
// move bound to that record, which that service's merge-pr.sh reads.
function serviceStore(db: DatabaseSync, environment: Environment, stateDir: string, now: () => Date): LocalTicketStore {
  const { conf, signer, users } = environment;
  return new LocalTicketStore(db, {
    stateDir, users, now: () => now().toISOString(), states: conf.states,
    ...(conf.ownerId ? { ownerId: conf.ownerId } : {}), ...(conf.publicKey ? { publicKey: conf.publicKey } : {}), ...(signer ? { signer } : {}),
  });
}

// The lock of each service of a workspace of several, for the flow's train
// (release/train.ts): its broker, over its own socket, and its own state
// folder for the validations and the review reports.
export function serviceLocks(db: DatabaseSync, workspace: WorkspaceConfig, options: ServiceLockOptions = {}): (service: ServiceConfig) => ServiceLock {
  const env = options.env ?? process.env;
  const paths = lockPaths(workspace, env);
  const now = options.now ?? (() => new Date());
  const made = new Map<string, ServiceLock>();
  return (service) => {
    const known = made.get(service.name);
    if (known) return known;
    const where = paths.get(service.name);
    if (!where) throw new Error(`${service.name} is not a service of workspace ${workspace.id}`);
    const broker = options.broker?.(where) ?? new SocketReleaseBroker(where.socket, { stateDir: where.stateDir });
    const environment = () => options.environment ?? approvalEnvironment(db, env);
    const lock: ServiceLock = {
      service: service.name,
      async recordReview(review) {
        const { verdictPhrase, ...record } = review;
        await new LedgerReviewRecorder(db, { stateDir: where.stateDir, verdict: verdictPhrase }).record(record);
      },
      async ask(input) {
        const answer = await broker.requestApproval({ ticket: input.ticket, pr: input.pr, request: input.request });
        if (!answer.ok) throw new Error(`the lock of ${service.name} refused the release request: ${(answer.reason || answer.output).trim() || 'no message'}`);
        const record = readApprovalRecord(where.stateDir, input.ticket);
        if (!record || !record.versions.some((v) => v.pr === input.pr)) throw new Error(`the lock of ${service.name} kept no request for pull request #${input.pr}`);
        return { requestedAt: record.at };
      },
      check(input) {
        const record = readApprovalRecord(where.stateDir, input.ticket);
        if (!record) return `no request for agreement is kept for this ticket on ${service.name}`;
        if (record.at !== input.requestedAt) return `the request to ${service.name} was made again since the card was shown: review again`;
        if (!sameVersions(record.versions, [input.head])) return `the version kept on ${service.name} is not the one the card showed: review again`;
        return undefined;
      },
      async sign(input) {
        await serviceStore(db, environment(), where.stateDir, now).recordApproval(input.ticket, input);
      },
      async release(input) {
        return outcomeOf(await broker.requestRelease({ ticket: input.ticket, pr: input.pr, announcement: input.announcement, fromQueue: true }));
      },
      async rollback(input) {
        const answer = await broker.requestRollback(input.ticket);
        return { ok: answer.ok, message: (answer.reason || answer.output).trim() };
      },
    };
    made.set(service.name, lock);
    return lock;
  };
}

// ---------------------------------------------------------------- the approval of a train

// A train blocked before approval (the compatibility check): the route
// answers 409 with the proposal.
export class TrainBlocked extends Error {
  override name = 'TrainBlocked';
  readonly proposal: string;
  constructor(reason: string, proposal: string) {
    super(reason);
    this.proposal = proposal;
  }
}

export type TrainApprovalOptions = {
  readonly db: DatabaseSync;
  readonly workspace: WorkspaceConfig;
  readonly locks: (service: ServiceConfig) => ServiceLock;
  readonly environment: Environment;
  readonly env?: NodeJS.ProcessEnv;
  readonly timers?: Timers;
  readonly graceMs?: number;
  readonly now?: () => Date;
};

const byHead = (a: Version, b: Version) => a.pr - b.pr || a.head.localeCompare(b.head);

// The owner's one gesture on a train's card. Every service's record must
// still hold the head the card showed; the grace is the approval writer's,
// on the first service's ticket store, so the owner's move it signs is bound
// to the first service's record; the train signs the next ones, bound to
// theirs, as each lands. The approver is kept with the train.
export class TrainApprovals {
  readonly #options: TrainApprovalOptions;
  readonly #trains: TrainStore;
  readonly #writers = new Map<string, LockApprovalWriter>();

  constructor(options: TrainApprovalOptions) {
    this.#options = options;
    this.#trains = new TrainStore(options.db, options.now);
  }

  // The train of the ticket's release item still waiting, if it is one.
  waiting(ticket: string): Train | undefined {
    const train = this.#trains.latest(ticket);
    if (!train || (train.state !== 'waiting' && train.state !== 'blocked')) return undefined;
    try {
      const row = this.#options.db.prepare("SELECT 1 FROM flow_inbox WHERE id = ? AND state = 'waiting'").get(train.item);
      return row ? train : undefined;
    } catch {
      return undefined;
    }
  }

  #writer(service: string): LockApprovalWriter {
    const known = this.#writers.get(service);
    if (known) return known;
    const { db, environment } = this.#options;
    const now = this.#options.now ?? (() => new Date());
    const stateDir = lockPaths(this.#options.workspace, this.#options.env ?? process.env).get(service)?.stateDir ?? environment.stateDir;
    const writer = new LockApprovalWriter({
      store: serviceStore(db, environment, stateDir, now), db, users: environment.users, proof: environment.proof, ownerId: environment.conf.ownerId, now, broker: null,
      ...(this.#options.timers ? { timers: this.#options.timers } : {}), ...(this.#options.graceMs !== undefined ? { graceMs: this.#options.graceMs } : {}),
    });
    this.#writers.set(service, writer);
    return writer;
  }

  #service(name: string): ServiceConfig {
    const service = this.#options.workspace.services.find((s) => s.name === name);
    if (!service) throw new ApprovalError('setup', `${name} is not a service of this workspace`);
    return service;
  }

  async begin(request: ApprovalRequest): Promise<{ readonly dueAt: string }> {
    const train = this.waiting(request.ticket);
    if (!train) throw new ApprovalError('state', 'no release train waits for the owner on this ticket');
    if (train.state === 'blocked' && train.blocked) throw new TrainBlocked(train.blocked.reason, train.blocked.proposal);
    const first = train.stops[0];
    if (!first) throw new ApprovalError('state', 'the train has no service');
    const shown = train.stops.map((stop) => ({ pr: stop.pr.number, head: stop.head })).sort(byHead);
    const asked = [...request.heads].map(({ pr, head }) => ({ pr, head })).sort(byHead);
    if (request.requestedAt !== first.requestedAt || !sameVersions(shown, asked)) throw new ApprovalError('version', 'the versions asked for are not the ones the card showed: review again');
    for (const stop of train.stops) {
      const why = this.#options.locks(this.#service(stop.service)).check({ ticket: request.ticket, requestedAt: stop.requestedAt, head: { pr: stop.pr.number, head: stop.head } });
      if (why) throw new ApprovalError('version', why);
    }
    const held = await this.#writer(first.service).begin({ ticket: request.ticket, by: request.by, requestedAt: first.requestedAt, heads: [{ pr: first.pr.number, head: first.head }] });
    this.#trains.setApprover(train.item, request.by);
    return held;
  }

  async undo(ticket: string, by: string): Promise<{ readonly undone: boolean }> {
    const train = this.waiting(ticket);
    const first = train?.stops[0];
    if (!train || !first) return { undone: false };
    const undone = await this.#writer(first.service).undo(ticket, by);
    if (undone.undone) this.#trains.setApprover(train.item, null);
    return undone;
  }
}
