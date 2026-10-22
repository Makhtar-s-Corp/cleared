// The author's host tools (docs/v2/milestone-2-plan.md, decisions 22 and
// 23, lane 17), declared as data like the lead's (lead/contract.ts): the
// model sees each as mcp__cleared__<name>, with its description and its
// schema, and the runner relays each call to the host. The engine binds the
// handlers for each author session it starts (bindAuthorTools); the checks
// below run before anything is journaled, and a refusal is what the model
// reads.
//
//   propose_session_plan: the author's first turn ends with its plan (its
//   steps, the files it means to change, its confidence and why); the flow
//   holds it until a Go (flow/plan-gate.ts).
//   report_changes: at the end of its work, the changed files grouped by
//   intent; a file in two groups is refused, and the changed files no group
//   names go to "Other changes". The release card reads the last report
//   (release/flags.ts).
import { posix } from 'node:path';
import type { ChangesReport, SessionPlan } from '../api/types.ts';
import { WORKDIR_MOUNT } from '../container/session-runtime.ts';
import { HostToolRefused, type HostCallContext, type HostTool, type JsonSchema } from '../session/contract.ts';

export type AuthorToolName = 'propose_session_plan' | 'report_changes';

export type AuthorToolInput = {
  propose_session_plan: Pick<SessionPlan, 'steps' | 'files' | 'confidence' | 'reason'>;
  report_changes: ChangesReport;
};

// The group the files no group names go to.
export const OTHER_CHANGES = 'Other changes';

// What a plan or a report may hold: enough for a ticket, not a document.
const MAX_STEPS = 30;
const MAX_FILES = 200;
const MAX_GROUPS = 20;
const MAX_TEXT = 500;
const MAX_REASON = 2000;

const text = (description: string): JsonSchema => ({ type: 'string', description });
const list = (description: string): JsonSchema => ({ type: 'array', items: { type: 'string' }, description });

export const AUTHOR_TOOLS: readonly (Pick<HostTool, 'description' | 'inputSchema'> & { readonly name: AuthorToolName })[] = [
  {
    name: 'propose_session_plan',
    description: 'Before you change any file, propose your plan for this ticket: the steps, the files you mean to change, your confidence and why. Then end your turn: Cleared tells you when to start (the Go), or what to change in the plan.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: list('The steps you will take, in order, one short sentence each.'),
        files: list('The files you mean to change or create, as paths in the checkout.'),
        confidence: { type: 'string', enum: ['low', 'medium', 'high'], description: 'high: the change is clear and small; medium: one point is uncertain; low: you need the owner to look first.' },
        reason: text('Why this confidence, in one or two sentences.'),
      },
      required: ['steps', 'files', 'confidence', 'reason'],
    },
  },
  {
    name: 'report_changes',
    description: 'When your work is committed, report what you changed, grouped by intent: each group a short intent and its files. A file belongs to one group only; the files you changed and name in no group are listed under "Other changes".',
    inputSchema: {
      type: 'object',
      properties: {
        groups: {
          type: 'array',
          description: 'The groups of your change, the most important first.',
          items: { type: 'object', properties: { intent: text('What this group of changes does, in a few words.'), files: list('Its files, as paths in the checkout.') }, required: ['intent', 'files'] },
        },
      },
      required: ['groups'],
    },
  },
];

export type AuthorHandlers = {
  readonly [N in AuthorToolName]?: (input: AuthorToolInput[N], context: HostCallContext) => Promise<string>;
};

const refuse = (message: string): never => { throw new HostToolRefused(message); };

// The host tools of the handlers given, in the contract's order. Each
// handler gets the input its check read (readSessionPlan, readChangesReport
// with the session's changed files is the handler's, since it needs them).
export function bindAuthorTools(handlers: AuthorHandlers): HostTool[] {
  return AUTHOR_TOOLS.flatMap((definition): HostTool[] => {
    const handler = handlers[definition.name] as ((input: unknown, context: HostCallContext) => Promise<string>) | undefined;
    return handler ? [{ ...definition, handle: (input, context) => handler(input, context) }] : [];
  });
}

function textOf(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') return refuse(`${what} is a text, and it is missing.`);
  const trimmed = value.trim();
  if (trimmed.length > max) return refuse(`${what} is at most ${max} characters.`);
  return trimmed;
}

function textsOf(value: unknown, what: string, max: number, unit: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return refuse(`${what} is a list of texts.`);
  if (value.length > max) return refuse(`${what} holds at most ${max} ${unit}.`);
  return value as string[];
}

// A path of the checkout, relative to it: the container's mount point is
// taken off; a path outside the checkout is refused.
export function checkoutPath(path: string): string {
  const trimmed = path.trim();
  const rel = posix.isAbsolute(trimmed) ? posix.relative(WORKDIR_MOUNT, trimmed) : posix.normalize(trimmed);
  if (rel === '' || rel === '.' || rel === '..' || rel.startsWith('../') || posix.isAbsolute(rel)) return refuse(`${trimmed.slice(0, 200)} is not a path inside the checkout.`);
  if (rel.length > MAX_TEXT) return refuse(`A path is at most ${MAX_TEXT} characters.`);
  return rel;
}

const unique = (paths: readonly string[]): string[] => [...new Set(paths)];

// The plan's input as the model gave it, checked; the times are the flow's.
export function readSessionPlan(input: unknown): AuthorToolInput['propose_session_plan'] {
  const record = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const steps = textsOf(record.steps, 'steps', MAX_STEPS, 'steps').map((step) => textOf(step, 'A step', MAX_TEXT));
  if (steps.length === 0) refuse('A plan has at least one step.');
  const files = unique(textsOf(record.files, 'files', MAX_FILES, 'files').map(checkoutPath));
  const confidence = record.confidence;
  if (confidence !== 'low' && confidence !== 'medium' && confidence !== 'high') refuse('confidence is low, medium or high.');
  const reason = textOf(record.reason, 'The reason of the confidence', MAX_REASON);
  return { steps, files, confidence: confidence as SessionPlan['confidence'], reason };
}

// The report as the model gave it, checked against the files the session
// is known to have changed (`changed`, relative to the checkout): a file
// named in two groups is refused; a changed file no group names goes to
// "Other changes". A file the journal does not know (written by a command)
// stays where the author put it; the published diff is the release card's
// reference (lane 18).
export function readChangesReport(input: unknown, changed: readonly string[]): ChangesReport {
  const record = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const raw = record.groups;
  if (!Array.isArray(raw)) return refuse('groups is a list of groups, each an intent and its files.');
  if (raw.length > MAX_GROUPS) refuse(`A report holds at most ${MAX_GROUPS} groups.`);
  const owner = new Map<string, string>();
  const groups: { intent: string; files: string[] }[] = [];
  for (const group of raw as unknown[]) {
    const g = (typeof group === 'object' && group !== null ? group : {}) as Record<string, unknown>;
    const intent = textOf(g.intent, 'An intent', MAX_TEXT);
    if (intent.toLowerCase() === OTHER_CHANGES.toLowerCase()) refuse(`"${OTHER_CHANGES}" is the group Cleared writes for the files no group names: give each group its intent.`);
    const files = unique(textsOf(g.files, `The files of "${intent}"`, MAX_FILES, 'files').map(checkoutPath));
    for (const file of files) {
      const first = owner.get(file);
      if (first !== undefined) refuse(`${file} is in two groups ("${first}" and "${intent}"): a file belongs to one group only. Report again with each file once.`);
      owner.set(file, intent);
    }
    groups.push({ intent, files });
  }
  const rest = unique(changed).filter((file) => !owner.has(file));
  return { groups: rest.length > 0 ? [...groups, { intent: OTHER_CHANGES, files: rest }] : groups };
}
