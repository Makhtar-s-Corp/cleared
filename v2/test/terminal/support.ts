// A session's container for the human side's tests: its programs
// (src/terminal/container.ts) run by this machine's node against a temporary
// checkout standing for the container's /workspace, and a terminal process
// that records what it is given. Every call is recorded.
import { commandRunner, type DockerResult } from '../../src/container/docker.ts';
import { WORKDIR_MOUNT } from '../../src/container/session-runtime.ts';
import type { SessionContainer, TerminalProcess } from '../../src/terminal/container.ts';

export type ExecCall = { readonly session: string; readonly command: readonly string[]; readonly input: string | undefined };

export class FakeTerminal implements TerminalProcess {
  readonly command: readonly string[];
  readonly written: string[] = [];
  readonly sizes: { cols: number; rows: number }[] = [];
  ended = 0;
  // Runs at each end: a test's hook (the order of a Give back).
  onEnd: () => void = () => {};
  #output: ((chunk: Buffer) => void)[] = [];
  #exit: (() => void)[] = [];
  write(data: string): void { this.written.push(data); }
  async resize(cols: number, rows: number): Promise<void> { this.sizes.push({ cols, rows }); }
  onOutput(listener: (chunk: Buffer) => void): void { this.#output.push(listener); }
  onExit(listener: () => void): void { this.#exit.push(listener); }
  constructor(command: readonly string[] = []) { this.command = command; }
  async end(): Promise<void> { this.ended++; this.onEnd(); }
  print(bytes: string | Buffer): void { for (const listener of this.#output) listener(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)); }
  exit(): void { for (const listener of this.#exit.splice(0)) listener(); }
}

const node = commandRunner(process.execPath);

export class LocalContainer implements SessionContainer {
  readonly root: string;
  readonly calls: ExecCall[] = [];
  readonly terminals: FakeTerminal[] = [];
  // Runs before each program, with its call: a test's hook (the race tests).
  before: (call: ExecCall) => void = () => {};
  // Awaited before a terminal starts: a test's hold (a Give back during the open).
  hold: () => Promise<void> = () => Promise.resolve();
  // A result that replaces the program's, for failure injection.
  answer: (call: ExecCall) => DockerResult | undefined = () => undefined;

  constructor(root: string) {
    this.root = root;
  }

  async exec(session: string, command: readonly string[], options: { readonly input?: string } = {}): Promise<DockerResult> {
    const call = { session, command: [...command], input: options.input };
    this.calls.push(call);
    this.before(call);
    const replaced = this.answer(call);
    if (replaced) return replaced;
    if (command[0] !== 'node') throw new Error(`the local container runs node programs only, not ${command[0]}`);
    return node(command.slice(1).map((word) => (word === WORKDIR_MOUNT ? this.root : word)), { input: options.input ?? '' });
  }

  async terminal(_session: string, size: { readonly cols: number; readonly rows: number }, command: readonly string[]): Promise<TerminalProcess> {
    await this.hold();
    const terminal = new FakeTerminal(command);
    terminal.sizes.push({ ...size });
    this.terminals.push(terminal);
    return terminal;
  }
}
