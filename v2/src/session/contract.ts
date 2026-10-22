// The session contract: the only thing the core sees of a harness
// (docs/v2/milestone-1-plan.md, section 3). It is aligned on ACP: every
// method, decision kind, tool kind and stop reason is an ACP name or maps to
// one in a line. Erasable syntax only: no enum.
//
// SessionEvent is defined in events.ts; Policy in policy.ts, which imports
// Role from here. Both imports are type-only, so the cycle has no runtime
// effect under type stripping.
import type { ServiceSpec, SiblingSpec } from '../container/services.ts';
import type { SessionEvent } from './events.ts';
import type { Policy } from './policy.ts';

export type Harness = 'claude-code' | 'codex';            // codex: milestone 3
// lead: milestone 2; reader: a read-only question to the code (milestone 2, decision 28)
export type Role = 'author' | 'reviewer' | 'lead' | 'reader';
export type SessionId = string;                            // UUID chosen by Cleared; given to the harness when it accepts one
export type UserId = string;                               // a row of the users table (lane 6)

export type Briefing = {
  readonly projectPage: string;
  readonly decisions: readonly string[];                   // approved decisions linked to the ticket
  readonly glossary: readonly string[];
  readonly lessons: readonly string[];                     // for this role
  readonly lastHandover: string | null;
};

export type StartInput = {
  readonly project: string;
  readonly ticket: string;
  readonly role: Role;
  readonly harness: Harness;
  readonly model: string;                                  // explicit, for example 'claude-opus-5-5'
  readonly workdir: string;                                // host path of the ticket checkout, mounted in the container
  readonly briefing: Briefing;
  readonly policy: Policy;                                 // section 5
  readonly prompt: string;                                 // the first user turn: the ticket and its criteria
  readonly services?: readonly ServiceSpec[];              // the project's test services, run beside the session
  // Milestone 2 (decision 20): the workspace service the session works on;
  // the other services (and its own, when it runs) as siblings on its
  // network; the host folder of the project's skills, mounted read only.
  readonly service?: string;
  readonly siblings?: readonly SiblingSpec[];
  readonly skills?: string;
  readonly tools?: readonly HostTool[];                    // milestone 2: the host's tools, the lead's (lead/contract.ts)
};

export type UserMessage = {
  readonly text: string;
  // Every message is attached to a user (brief 5.9), or to the lead writing
  // to a team, or to the flow itself ('cleared': the reopen message).
  readonly by: UserId | 'lead' | 'cleared';
};

// The JSON Schema subset a host tool's input is written in: what the runner
// can turn into the SDK's schema (milestone 2 plan, section 3.1). No other
// keyword: no integer, no length or count bounds, no map type.
export type JsonSchema =
  | { readonly type: 'object'; readonly properties: Readonly<Record<string, JsonSchema>>; readonly required?: readonly string[]; readonly description?: string }
  | { readonly type: 'array'; readonly items: JsonSchema; readonly description?: string }
  | { readonly type: 'string'; readonly enum?: readonly string[]; readonly description?: string }
  | { readonly type: 'number'; readonly description?: string }
  | { readonly type: 'boolean'; readonly description?: string };

// What a host tool's handler is told of the call.
export type HostCallContext = { readonly sessionId: SessionId; readonly turn: string };

// A tool the host gives a session: the model sees its name (as
// mcp__cleared__<name>), its description and its schema; the runner relays
// each call to the host, which runs `handle` and answers with its result
// (text, or a value the host writes as JSON). A handler that refuses throws
// HostToolRefused, whose message is the answer the model reads and the
// `message` of the cleared.host_call event (outcome 'refused'); any other
// error is outcome 'failed', and its message stays on the host.
export type HostTool = {
  readonly name: string;                                   // [a-z_]+
  readonly description: string;
  readonly inputSchema: JsonSchema & { readonly type: 'object' };
  handle(input: unknown, context: HostCallContext): Promise<unknown>;
};

// What answers a permission request or a question. The first four are ACP's
// PermissionOptionKind values; 'answer' serves a question; 'cancelled' is the
// outcome ACP requires when the turn was interrupted while a request waited.
export type Decision =
  | { readonly kind: 'allow_once' }
  | { readonly kind: 'allow_always'; readonly scope: 'project' }
  | { readonly kind: 'reject_once'; readonly message: string }
  | { readonly kind: 'reject_always'; readonly message: string }
  | { readonly kind: 'answer'; readonly answers: Readonly<Record<string, string>> }
  | { readonly kind: 'cancelled' };

export type Answer = {
  readonly decision: Decision;
  readonly by: UserId | 'policy';                          // who decided: a user, or a policy rule
  readonly rule?: string;                                  // the rule id when the policy decided
};

// ACP StopReason values, plus 'error' for a harness process that died.
export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' | 'error';

// The harness's own interactive program, resumed on a session for the human
// who took it over, at the web terminal in the session's container (owner
// request of 2026-10-22 17:26): what to run there (fixed words, the session
// and its model, never a secret), and the harness's name; or why this
// harness has none, said in the terminal, where the Shell is offered instead.
export type InteractiveResume =
  | { readonly supported: true; readonly name: string; readonly command: readonly string[] }
  | { readonly supported: false; readonly reason: string };

export interface SessionAdapter {
  readonly harness: Harness;
  start(input: StartInput): Promise<SessionHandle>;        // ACP: initialize, then session/new
  resume(id: SessionId): Promise<SessionHandle>;           // ACP: session/resume (sessionCapabilities.resume) or session/load
  // Optional: an adapter without it has no interactive resume. When it
  // answers supported, the session's own harness process has been handed
  // over (only one harness writes the session at a time), and resume()
  // takes it back from the transcript the human's harness left.
  interactive?(id: SessionId): Promise<InteractiveResume>;
}

export interface SessionHandle {
  readonly id: SessionId;
  send(message: UserMessage): Promise<void>;               // ACP: session/prompt
  events(afterSeq?: number): AsyncIterable<SessionEvent>;  // ACP: session/update notifications; section 4
  answer(requestId: string, answer: Answer): Promise<void>; // ACP: the response to session/request_permission
  interrupt(): Promise<void>;                              // ACP: session/cancel
  stop(): Promise<void>;                                   // ACP: session/close; here: stop and remove the container
  handover(to: { readonly harness: Harness; readonly model: string }): Promise<never>; // milestone 3: rejects with NotImplemented
}

// ACP ToolKind and ToolCallStatus values, used to classify every tool call
// whatever the harness calls the tool.
export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';
export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

// The adapter's interactive resume, or why there is none: an adapter
// without the method (Codex and Cursor until theirs come) or with no
// adapter at all is unsupported, and so is one that fails, whose error
// stays on the host.
export async function interactiveResume(adapter: SessionAdapter | undefined, id: SessionId): Promise<InteractiveResume> {
  if (!adapter) return { supported: false, reason: 'This session has no harness adapter here: open the Shell instead.' };
  if (!adapter.interactive) return { supported: false, reason: `The ${adapter.harness} harness cannot be resumed in a terminal yet: open the Shell instead.` };
  try {
    return await adapter.interactive(id);
  } catch (error) {
    console.error(`cleared-v2: the ${adapter.harness} harness of session ${id} could not be resumed in a terminal (${error instanceof Error ? error.name : typeof error})`);
    return { supported: false, reason: `The ${adapter.harness} harness could not be resumed in a terminal: open the Shell instead.` };
  }
}

// What a later milestone brings, asked for too early.
export class NotImplemented extends Error {
  override name = 'NotImplemented';
}

// A host tool's refusal: what the lead may not do, said to the model.
export class HostToolRefused extends Error {
  override name = 'HostToolRefused';
}
