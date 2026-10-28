// What the flow needs to know about the project it serves, and where it
// reads it: the environment of the service for the fixed parts (which
// workspace and services, which models, the limits), and each service's own
// .cleared/agents.conf, read at the base branch by the service and never
// from a session's copy, for the verdict phrase, the safe commands and the
// hosts (docs/v2/milestone-1-plan.md, sections 5 and 8, lane 7; the
// workspace: docs/v2/milestone-2-plan.md, decision 18, lane 14).
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { ServiceError, parseServices, type ServiceSpec } from '../container/services.ts';
import { parseCommand } from '../session/policy.ts';
import { parseEditorHost } from './editor-link.ts';
import { pickHarnessesOf, type PickHarness } from './harness-pick.ts';
import { WorkspaceError, loadWorkspace, parseConf, serviceNameOf, type Sections, type WorkspaceConfig } from '../workspace/config.ts';

// The format of agents.conf is read by workspace/config.ts, which reads the
// workspace file in the same format.
export { parseConf, type Sections };

export class FlowConfigError extends Error {
  override name = 'FlowConfigError';
}

export type FlowConfig = {
  readonly project: string;                 // the workspace's id, as tickets name it (their `project`)
  readonly projectDir: string;              // the first service's checkout on this server
  readonly repoUrl: string;                 // its address on the forge
  readonly repo: string;                    // owner/name, for gh
  readonly base: string;                    // the base branch
  readonly workdirRoot: string;             // the ticket checkouts live under it
  readonly authorModel: string;
  readonly reviewerModel: string;           // another model than the author's
  readonly idleMs: number;                  // a session with no activity for this long is stopped
  readonly maxReviewRounds: number;         // the verdicts of a ticket's review channel before it goes back (issue 291)
  readonly budgetUsd: number | undefined;   // the ticket's budget; none when unset
  // CLEARED_V2_EDITOR_SSH_HOST: the host an editor reaches this server by
  // over SSH, as the person's ssh config names it; none: the editor is on
  // this machine (flow/editor.ts).
  readonly editorHost?: string | undefined;
  readonly mergeRetryMs: number;            // a merge the lock queued is asked again after this long
  // CLEARED_NOTIFY_LINK_BASE: the app's address as people open it, which
  // the notifications link to; the proof receipt links its captures there
  // (P210). None: the receipt says the captures are kept by Cleared.
  readonly linkBase?: string | undefined;
  // How long the proof receipt's captures may take before the ticket goes
  // on without them (P210); 90 seconds when unset. The tests set it short.
  readonly proofTimeoutMs?: number;
  // The workspace and its services. loadFlowConfig always sets it; a
  // configuration written without it reads as its one-service workspace
  // (workspaceOf).
  readonly workspace?: WorkspaceConfig;
  // The author's host tools (decisions 22 and 23, lane 17): its session plan
  // proposed before the code and held until a Go, and its report of its
  // changes by intent. loadFlowConfig always sets it; a configuration
  // written without it (milestone 1's, the tests' literals) runs the flow
  // as milestone 1 did, with no tool and no gate.
  readonly authorTools?: boolean;
  // A ticket runs in steps (decision 26, lane 23): a contract step, a step
  // per service, an integration step, each its own author session.
  // loadFlowConfig always sets it; a configuration written without it runs
  // one author per ticket, as before.
  readonly steps?: boolean;
  // A team's question to the owner (issue #290): past questionTimeoutMs
  // from when it was asked, the lead is asked to decide, for questionLeadMs;
  // then the session's declared answer applies, or the ticket is parked.
  // loadFlowConfig always sets both; a configuration written without them
  // takes QUESTION_TIMEOUT_MINUTES and QUESTION_LEAD_MINUTES.
  readonly questionTimeoutMs?: number;
  readonly questionLeadMs?: number;
  // The harnesses a harness pick may run (issue #329), each with its model
  // when named: CLEARED_V2_PICK_HARNESSES. loadFlowConfig always sets it; a
  // configuration written without it allows Claude Code alone (PICK_DEFAULT).
  readonly pickHarnesses?: readonly PickHarness[];
  // The wait before the first recreation of a session's container that
  // stopped (issue #453), doubled at each next one; RECREATE_BACKOFF_MS
  // when unset. The tests set it short.
  readonly recreateBackoffMs?: number;
};

// How long a team's question waits for the owner before the lead decides
// (CLEARED_V2_QUESTION_TIMEOUT_MINUTES), and how long the lead has before
// the session's declared answer applies or its ticket is parked.
export const QUESTION_TIMEOUT_MINUTES = 30;
export const QUESTION_LEAD_MINUTES = 10;

// How long a high-confidence session plan waits for a Go before it starts
// by itself, and a session that proposed none before it is put back, when
// the service's [session] plan_go_minutes does not say (decision 22).
export const PLAN_GO_MINUTES = 10;

export type ProjectSettings = {
  readonly verdict: string;                 // [merge] verdict: the phrase a passing review ends with
  readonly safeCommands: readonly string[]; // [session] safe_commands, added to Cleared's defaults
  readonly hosts: readonly string[];        // [session] hosts, added to the model API
  readonly services: readonly ServiceSpec[]; // [session] services, started beside each session
  readonly scripts: readonly string[];      // the scripts of package.json on the base branch
  readonly planGoMinutes?: number;          // [session] plan_go_minutes, when set: the session plan's delay (PLAN_GO_MINUTES otherwise)
  // [session] service_urls, when set: for each service it consumes, the
  // variable its code reads that service's address from (`filter-api:FILTER_URL`),
  // given to its sibling in a step's trial environment (lane 23).
  readonly serviceUrls?: Readonly<Record<string, string>>;
  readonly guardedPaths?: readonly string[]; // [merge] guarded_paths, when set: the release card's `config` flag reads them (lane 23)
  // [session] test_command, its words: the one command a reviewer runs
  // (issue #268). Not declared, `npm test` when package.json has a test
  // script, else none: the reviewer then runs no code.
  readonly testCommand?: readonly string[];
  // A team's question of this project (issue #269): [session]
  // question_timeout_minutes, when set, its delay (the service's
  // CLEARED_V2_QUESTION_TIMEOUT_MINUTES otherwise), and [session]
  // question_default, when set, the answer its delay's end applies
  // (QUESTION_DEFAULTS; 'recommended' otherwise).
  readonly questionTimeoutMinutes?: number;
  readonly questionDefault?: QuestionDefault;
  // [release] production_url, when set: the page the flow opens and
  // captures once a release it merged after the human's approval is
  // deployed and its watch ended healthy (P218, flow/proof-capture.ts
  // captureProduction). Never the health address: the configured page only.
  readonly productionUrl?: string;
};

// What a question's delay ends on when neither the owner nor the lead
// answered (flow/questions.ts, defaultAnswers): `recommended`, each
// question's "(Recommended)" option, the session's declared answer;
// `first`, that option, else each question's first; `park`, nothing, the
// ticket parked.
export const QUESTION_DEFAULTS = ['recommended', 'first', 'park'] as const;
export type QuestionDefault = (typeof QUESTION_DEFAULTS)[number];

const list = (value: string | undefined): string[] => (value ?? '').split(',').map((word) => word.trim()).filter(Boolean);

// A project with no verdict phrase cannot pass a review: merge-pr.ts reads
// the same phrase, and a review that cannot say it is not accepted there.
export function projectSettings(sections: Sections, scripts: readonly string[] = []): ProjectSettings {
  const verdict = sections.merge?.verdict?.trim();
  if (!verdict) throw new FlowConfigError('the project names no [merge] verdict phrase in .cleared/agents.conf: a review cannot pass without it');
  let services: ServiceSpec[];
  try {
    services = parseServices(sections.session?.services ?? '');
  } catch (error) {
    if (error instanceof ServiceError) throw new FlowConfigError(`[session] services: ${error.message}`);
    throw error;
  }
  const planGoMinutes = positive(sections.session?.plan_go_minutes, '[session] plan_go_minutes', false);
  const serviceUrls = urlVariables(sections.session?.service_urls);
  const guardedPaths = list(sections.merge?.guarded_paths);
  const testCommand = testCommandOf(sections.session?.test_command, scripts);
  const questionTimeoutMinutes = positive(sections.session?.question_timeout_minutes, '[session] question_timeout_minutes', false);
  const questionDefault = questionDefaultOf(sections.session?.question_default);
  const productionUrl = productionUrlOf(sections.release?.production_url);
  return {
    verdict, safeCommands: list(sections.session?.safe_commands), hosts: list(sections.session?.hosts), services, scripts,
    ...(planGoMinutes === undefined ? {} : { planGoMinutes }),
    ...(serviceUrls === undefined ? {} : { serviceUrls }),
    ...(guardedPaths.length === 0 ? {} : { guardedPaths }),
    ...(testCommand === undefined ? {} : { testCommand }),
    ...(questionTimeoutMinutes === undefined ? {} : { questionTimeoutMinutes }),
    ...(questionDefault === undefined ? {} : { questionDefault }),
    ...(productionUrl === undefined ? {} : { productionUrl }),
  };
}

// An http or https address with no user and no password: the capture is
// read by anyone who opens the ticket, and the message never repeats it.
function productionUrlOf(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  let url: URL | undefined;
  try { url = new URL(text); } catch { url = undefined; }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) throw new FlowConfigError('[release] production_url must be an http or https address');
  if (url.username || url.password) throw new FlowConfigError('[release] production_url carries credentials: give the page\'s address without them');
  return text;
}

function questionDefaultOf(value: string | undefined): QuestionDefault | undefined {
  const word = value?.trim();
  if (word === undefined || word === '') return undefined;
  if (!(QUESTION_DEFAULTS as readonly string[]).includes(word)) throw new FlowConfigError(`[session] question_default must be one of ${QUESTION_DEFAULTS.join(', ')}, not "${word}"`);
  return word as QuestionDefault;
}

// One simple command, read as the policy reads a session's: no list, pipe,
// redirection or expansion, so that what the reviewer may run is exactly it.
function testCommandOf(value: string | undefined, scripts: readonly string[]): readonly string[] | undefined {
  const text = value?.trim();
  if (!text) return scripts.includes('test') ? ['npm', 'test'] : undefined;
  const words = parseCommand(text);
  if (!words) throw new FlowConfigError(`[session] test_command must be one simple command (no list, pipe, redirection or expansion), not "${text}"`);
  return words;
}

// `<service>:<VARIABLE>` pairs, the variable an upper-case name ending in
// _URL, so that no setting of a service can name PATH or NODE_OPTIONS.
function urlVariables(value: string | undefined): Record<string, string> | undefined {
  const pairs = list(value);
  if (pairs.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const match = /^([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?):([A-Z][A-Z0-9_]*_URL)$/.exec(pair);
    if (!match) throw new FlowConfigError(`[session] service_urls: "${pair}" is not <service>:<VARIABLE_URL>, a service name and an upper-case variable ending in _URL`);
    out[match[1] as string] = match[2] as string;
  }
  return out;
}

function positive(value: string | undefined, name: string, integer: boolean): number | undefined {
  if (value === undefined || value === '') return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || (integer && !Number.isInteger(number))) throw new FlowConfigError(`${name} must be a positive ${integer ? 'whole ' : ''}number, not "${value}"`);
  return number;
}

function editorHost(value: string | undefined): string | undefined {
  try { return parseEditorHost(value); } catch (error) { throw new FlowConfigError((error as Error).message); }
}

// The flow's configuration, or undefined when the service is not set up to
// run tickets (neither CLEARED_V2_WORKSPACE nor CLEARED_V2_PROJECT): the
// service then still serves its health route and answers the API with "not
// configured". A workspace that is named but badly set up is an error, not a
// silent default. The milestone 1 fields name the workspace (`project`) and
// its first service (the checkout, the repository, the base branch).
export function loadFlowConfig(env: NodeJS.ProcessEnv = process.env): FlowConfig | undefined {
  const state = env.CLEARED_V2_STATE_DIR || join(env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state'), 'cleared-v2');
  const authorModel = env.CLEARED_V2_AUTHOR_MODEL || 'claude-opus-5-5';
  let workspace: WorkspaceConfig | undefined;
  try {
    workspace = loadWorkspace(env, { authorModel, stateDir: state });
  } catch (error) {
    if (error instanceof WorkspaceError) throw new FlowConfigError(error.message);
    throw error;
  }
  if (!workspace) return undefined;
  const first = workspace.services[0] as WorkspaceConfig['services'][number];
  const workdirRoot = env.CLEARED_V2_WORKDIRS || join(state, 'work');
  if (!isAbsolute(workdirRoot)) throw new FlowConfigError('CLEARED_V2_WORKDIRS must be an absolute path');
  const minutes = positive(env.CLEARED_V2_IDLE_MINUTES, 'CLEARED_V2_IDLE_MINUTES', false) ?? 15;
  const editor = editorHost(env.CLEARED_V2_EDITOR_SSH_HOST);
  const question = positive(env.CLEARED_V2_QUESTION_TIMEOUT_MINUTES, 'CLEARED_V2_QUESTION_TIMEOUT_MINUTES', false) ?? QUESTION_TIMEOUT_MINUTES;
  const pickHarnesses = pickHarnessesOf(env.CLEARED_V2_PICK_HARNESSES);
  return {
    project: workspace.id, projectDir: first.dir, repoUrl: first.url, repo: first.repo,
    base: first.base, workdirRoot,
    authorModel,
    reviewerModel: env.CLEARED_V2_REVIEWER_MODEL || 'claude-sonnet-5-5',
    idleMs: minutes * 60_000,
    maxReviewRounds: positive(env.CLEARED_V2_REVIEW_ROUNDS, 'CLEARED_V2_REVIEW_ROUNDS', true) ?? 3,
    budgetUsd: positive(env.CLEARED_V2_BUDGET_USD, 'CLEARED_V2_BUDGET_USD', false),
    ...(editor ? { editorHost: editor } : {}),
    ...(env.CLEARED_NOTIFY_LINK_BASE ? { linkBase: env.CLEARED_NOTIFY_LINK_BASE } : {}),
    mergeRetryMs: (positive(env.CLEARED_V2_MERGE_RETRY_SECONDS, 'CLEARED_V2_MERGE_RETRY_SECONDS', true) ?? 60) * 1000,
    questionTimeoutMs: question * 60_000,
    questionLeadMs: QUESTION_LEAD_MINUTES * 60_000,
    workspace,
    authorTools: true,
    steps: true,
    pickHarnesses,
  };
}

// The configuration's workspace: the one it carries, or the one-service
// workspace its milestone 1 fields describe.
export function workspaceOf(config: FlowConfig): WorkspaceConfig {
  if (config.workspace) return config.workspace;
  return {
    id: config.project, name: config.project, file: null,
    services: [{
      name: serviceNameOf(config.project), kind: 'repository', repo: config.repo, url: config.repoUrl, base: config.base, path: null, dir: config.projectDir,
      healthUrl: null, sensitivity: 'normal', consumes: [], run: null, contract: null, brokerSocket: null, brokerState: null,
    }],
  };
}
