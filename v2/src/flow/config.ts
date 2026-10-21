// What the flow needs to know about the project it serves, and where it
// reads it: the environment of the service for the fixed parts (which
// repository, which models, the limits), and the project's own
// .cleared/agents.conf, read at the base branch by the service and never
// from a session's copy, for the verdict phrase, the safe commands and the
// hosts (docs/v2/milestone-1-plan.md, sections 5 and 8, lane 7).
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export class FlowConfigError extends Error {
  override name = 'FlowConfigError';
}

export type FlowConfig = {
  readonly project: string;                 // the project's name, as tickets name it
  readonly projectDir: string;              // the service's checkout of the project
  readonly repoUrl: string;                 // its address on the forge
  readonly repo: string;                    // owner/name, for gh
  readonly base: string;                    // the base branch
  readonly workdirRoot: string;             // the ticket checkouts live under it
  readonly authorModel: string;
  readonly reviewerModel: string;           // another model than the author's
  readonly idleMs: number;                  // a session with no activity for this long is stopped
  readonly maxReviewRounds: number;         // the reviews a ticket gets before it goes back
  readonly budgetUsd: number | undefined;   // the ticket's budget; none when unset
};

export type Sections = Record<string, Record<string, string>>;

// The format of agents.conf: [section] headers, key = value lines, # or ;
// at the start of a line for a comment. A value keeps what follows it, a
// trailing # included, as v1 reads it.
export function parseConf(text: string): Sections {
  const sections: Sections = {};
  let current = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      current = header[1] as string;
      sections[current] ??= {};
      continue;
    }
    const at = line.indexOf('=');
    if (at < 0 || !current) continue;
    (sections[current] as Record<string, string>)[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return sections;
}

export type ProjectSettings = {
  readonly verdict: string;                 // [merge] verdict: the phrase a passing review ends with
  readonly safeCommands: readonly string[]; // [session] safe_commands, added to Cleared's defaults
  readonly hosts: readonly string[];        // [session] hosts, added to the model API
  readonly scripts: readonly string[];      // the scripts of package.json on the base branch
};

const list = (value: string | undefined): string[] => (value ?? '').split(',').map((word) => word.trim()).filter(Boolean);

// A project with no verdict phrase cannot pass a review: merge-pr.sh reads
// the same phrase, and a review that cannot say it is not accepted there.
export function projectSettings(sections: Sections, scripts: readonly string[] = []): ProjectSettings {
  const verdict = sections.merge?.verdict?.trim();
  if (!verdict) throw new FlowConfigError('the project names no [merge] verdict phrase in .cleared/agents.conf: a review cannot pass without it');
  return { verdict, safeCommands: list(sections.session?.safe_commands), hosts: list(sections.session?.hosts), scripts };
}

function positive(value: string | undefined, name: string, integer: boolean): number | undefined {
  if (value === undefined || value === '') return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || (integer && !Number.isInteger(number))) throw new FlowConfigError(`${name} must be a positive ${integer ? 'whole ' : ''}number, not "${value}"`);
  return number;
}

// The flow's configuration, or undefined when the service is not set up to
// run tickets (CLEARED_V2_PROJECT unset): the service then still serves its
// health route and answers the API with "not configured". A project that
// is named but badly set up is an error, not a silent default.
export function loadFlowConfig(env: NodeJS.ProcessEnv = process.env): FlowConfig | undefined {
  const project = env.CLEARED_V2_PROJECT;
  if (!project) return undefined;
  const need = (name: string): string => {
    const value = env[name];
    if (!value) throw new FlowConfigError(`${name} is not set, and CLEARED_V2_PROJECT names a project`);
    return value;
  };
  const projectDir = need('CLEARED_V2_PROJECT_DIR');
  if (!isAbsolute(projectDir)) throw new FlowConfigError('CLEARED_V2_PROJECT_DIR must be an absolute path');
  const repo = need('CLEARED_V2_REPO');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new FlowConfigError('CLEARED_V2_REPO must be owner/name');
  const state = env.CLEARED_V2_STATE_DIR || join(env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state'), 'cleared-v2');
  const workdirRoot = env.CLEARED_V2_WORKDIRS || join(state, 'work');
  if (!isAbsolute(workdirRoot)) throw new FlowConfigError('CLEARED_V2_WORKDIRS must be an absolute path');
  const minutes = positive(env.CLEARED_V2_IDLE_MINUTES, 'CLEARED_V2_IDLE_MINUTES', false) ?? 15;
  return {
    project, projectDir, repoUrl: need('CLEARED_V2_REPO_URL'), repo,
    base: env.CLEARED_V2_BASE || 'main', workdirRoot,
    authorModel: env.CLEARED_V2_AUTHOR_MODEL || 'claude-opus-5-5',
    reviewerModel: env.CLEARED_V2_REVIEWER_MODEL || 'claude-sonnet-5-5',
    idleMs: minutes * 60_000,
    maxReviewRounds: positive(env.CLEARED_V2_REVIEW_ROUNDS, 'CLEARED_V2_REVIEW_ROUNDS', true) ?? 2,
    budgetUsd: positive(env.CLEARED_V2_BUDGET_USD, 'CLEARED_V2_BUDGET_USD', false),
  };
}
