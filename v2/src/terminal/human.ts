// What a human does in a session's checkout, and what the session is told
// of it (docs/v2/milestone-2-plan.md, decisions 32 and 33, lane 31): the
// web terminals, the checkout's state at Take over, the editor's saves made
// while the session was taken over, and the journal of both. One per
// process, made by the flow module (modules/flow.ts) next to the engine.
//
// The events are appended to the session's journal through the store, as
// the engine's own are: the engine's journal is its own, and its stream's
// listeners see them at their next wake (15 seconds at most) rather than at
// once. Every text is cleaned first; no event carries a file's content or
// the terminal's output.
import { homedir } from 'node:os';
import type { HumanEdit } from '../api/types.ts';
import { LOGIN_FILE_MOUNT, WORKDIR_MOUNT } from '../container/session-runtime.ts';
import type { FlowEngine } from '../flow/engine.ts';
import { cleanText, secretValues } from '../session/clean.ts';
import type { SessionId, UserId } from '../session/contract.ts';
import type { AgUiEvent } from '../session/events.ts';
import type { Policy } from '../session/policy.ts';
import type { Store } from '../store/db.ts';
import { giveCommand, takeCommand, type SessionContainer } from './container.ts';
import { Terminals } from './terminals.ts';

export type HumanDeps = {
  readonly engine: FlowEngine;
  readonly store: Store;
  readonly container: SessionContainer;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly idleMs?: number;
};

// The checkout at Take over: the commit and the files that differed from it.
type Taken = { readonly head: string; readonly files: Readonly<Record<string, string | null>> };
type Found = { readonly path: string; readonly before: string | null; readonly after: string | null; readonly added: number; readonly removed: number };

// The events' cleaner with the service's secrets and folders, as flow/runtime.ts gives the engine.
export function serviceCleaner(engine: FlowEngine, env: NodeJS.ProcessEnv): (text: string) => string {
  return (text) => cleanText(text, {
    secrets: secretValues(env),
    servicePaths: [...new Set([env.CLEARED_V2_STATE_DIR, env.HOME ?? homedir(), engine.config.projectDir, engine.config.workdirRoot].filter((p): p is string => !!p && p !== '/'))],
  });
}

const name = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

export class HumanSide {
  readonly engine: FlowEngine;
  readonly container: SessionContainer;
  readonly terminals: Terminals;
  readonly clean: (text: string) => string;
  readonly #store: Store;
  readonly #now: () => Date;
  readonly #taken = new Map<SessionId, Taken | undefined>();
  readonly #held = new Map<SessionId, HumanEdit[]>();           // the editor's saves while taken over, told at Give back

  constructor(deps: HumanDeps) {
    this.engine = deps.engine;
    this.container = deps.container;
    this.#store = deps.store;
    this.#now = deps.now ?? (() => new Date());
    this.clean = serviceCleaner(deps.engine, deps.env ?? process.env);
    this.terminals = new Terminals({
      container: deps.container, clean: this.clean, journal: (session, event) => this.journal(session, event),
      now: () => this.#now().getTime(), ...(deps.idleMs === undefined ? {} : { idleMs: deps.idleMs }),
    });
  }

  // A terminal stays open only while its session is taken over.
  startTimer(): void {
    this.terminals.startTimer((session) => this.engine.takenOver(session) !== undefined);
  }

  journal(session: SessionId, event: AgUiEvent): void {
    const row = this.#store.sessions.get(session);
    if (!row) return;
    this.#store.events.append({ at: this.#now().toISOString(), sessionId: session, ticket: row.ticket, project: row.project, event });
  }

  // The author's policy as the session's own Write is judged by (the
  // engine's policyFor): the rows of its role, the "Always in this project"
  // answers; the scripts, the hosts and the ticket's files judge commands only.
  policy(project: string): Policy {
    return {
      role: 'author', base: this.engine.config.base, workdir: WORKDIR_MOUNT, scripts: [], credentialFile: LOGIN_FILE_MOUNT,
      safeCommands: [], allowedHosts: [], forbiddenHosts: [], ticketFiles: [], learned: this.#store.policyRules.learned(project),
    };
  }

  // Take over: the checkout's state, for Give back to find what the human
  // changed. A container that does not answer leaves no state, and Give back
  // then finds nothing from the terminal.
  async takenOver(session: SessionId): Promise<void> {
    this.#taken.set(session, await this.#take(session));
  }

  // A save of the editor, journaled; while the session is taken over it is
  // held for the Give back's notice, else the caller tells the session.
  edited(session: SessionId, edit: Omit<HumanEdit, 'at'>, takenOver: boolean): void {
    this.journal(session, { type: 'CUSTOM', name: 'cleared.human_edit', value: edit });
    if (takenOver) this.#held.set(session, [...(this.#held.get(session) ?? []), { ...edit, at: this.#now().toISOString() }]);
  }

  // Give back, before the session resumes: the terminal closed, the files it
  // changed found and journaled, and every change the session has not been
  // told of returned, the editor's first. A Give back that fails keeps them
  // for the next one, and the checkout's state moves to now, so nothing is
  // journaled twice.
  async givingBack(session: SessionId, by: UserId): Promise<readonly HumanEdit[]> {
    await this.terminals.close(session, by, 'give_back');
    const taken = this.#taken.get(session);
    const found = taken ? await this.#give(session, taken) : [];
    const held = this.#held.get(session) ?? [];
    const savedAfter = new Map(held.map((edit) => [edit.path, edit.after]));
    const at = this.#now().toISOString();
    const terminal: HumanEdit[] = [];
    for (const file of found) {
      const before = Object.hasOwn(taken?.files ?? {}, file.path) ? (taken?.files[file.path] ?? null) : file.before;
      if (before === file.after || savedAfter.get(file.path) === file.after) continue;
      const edit = { path: this.clean(file.path), by, added: file.added, removed: file.removed, before, after: file.after, via: 'terminal' as const };
      this.journal(session, { type: 'CUSTOM', name: 'cleared.human_edit', value: edit });
      terminal.push({ ...edit, at });
    }
    if (taken) this.#taken.set(session, await this.#take(session));
    const all = [...held, ...terminal];
    this.#held.set(session, all);
    return all;
  }

  // The session was given back: what it was told of is no longer held.
  given(session: SessionId): void {
    this.#taken.delete(session);
    this.#held.delete(session);
  }

  async #take(session: SessionId): Promise<Taken | undefined> {
    try {
      const result = await this.container.exec(session, takeCommand());
      if (result.code !== 0) return undefined;
      const parsed = JSON.parse(result.stdout) as Taken;
      return typeof parsed.head === 'string' && /^[0-9a-f]{40,64}$/.test(parsed.head) ? parsed : undefined;
    } catch (error) {
      console.error(`cleared-v2: the checkout of session ${session} could not be read at take over (${name(error)})`);
      return undefined;
    }
  }

  async #give(session: SessionId, taken: Taken): Promise<Found[]> {
    try {
      const result = await this.container.exec(session, giveCommand(taken.head), { input: JSON.stringify(Object.keys(taken.files)) });
      if (result.code !== 0) return [];
      return (JSON.parse(result.stdout) as { files: Found[] }).files;
    } catch (error) {
      console.error(`cleared-v2: the checkout of session ${session} could not be read at give back (${name(error)})`);
      return [];
    }
  }
}
