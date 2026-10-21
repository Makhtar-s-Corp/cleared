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
import { LedgerReviewRecorder, RUNS_TABLES, type ReviewRecorderOptions } from './review.ts';
import { ApprovalSigner, SigningKeyError } from './signer.ts';
import { LockApprovalWriter, type Timers } from './writer.ts';
import type { Ticket } from '../tickets/contract.ts';

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
    stateDir: options.stateDir, now: () => now().toISOString(),
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

export type Environment = ReturnType<typeof createApproval> & { readonly conf: LockConf };

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
  const parts = createApproval({
    db, users: new SqliteUsers(db), stateDir, proof, ownerId: conf.ownerId, publicKey: conf.publicKey, signer, states: conf.states, verdict: conf.verdict,
    broker: new SocketReleaseBroker(socket, { stateDir }), resolveHead: ghHead(env.CLEARED_REPO || env.ORCH_REPO),
  });
  const built: Environment = { ...parts, conf };
  environments.set(db, built);
  return built;
}
