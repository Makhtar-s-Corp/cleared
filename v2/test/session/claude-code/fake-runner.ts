// A stand-in for the runner in the session container (images/session/
// runner/main.ts), one per `docker start --attach`: the test reads what the
// adapter writes to its stdin and writes the runner's lines to its stdout.
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';

// One fake runner per attach: what the adapter wrote, and a way to answer.
export class FakeRunner {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly received: Record<string, unknown>[] = [];
  readonly process: ChildProcessWithoutNullStreams;
  private readonly emitter = new EventEmitter();

  // Called with each line the adapter writes, after it is recorded.
  readonly listeners = new Set<(line: Record<string, unknown>) => void>();

  constructor() {
    createInterface({ input: this.stdin }).on('line', (text) => {
      const line = JSON.parse(text) as Record<string, unknown>;
      this.received.push(line);
      for (const listener of this.listeners) listener(line);
    });
    this.process = Object.assign(this.emitter, {
      stdin: this.stdin, stdout: this.stdout, stderr: this.stderr, pid: 4242, exitCode: null,
      kill: () => { this.exit(137); return true; },
    }) as unknown as ChildProcessWithoutNullStreams;
  }

  say(value: unknown) { this.stdout.write(JSON.stringify(value) + '\n'); }
  sdk(message: unknown) { this.say({ type: 'sdk', message }); }
  exit(code: number) {
    this.stdout.end();
    setImmediate(() => this.emitter.emit('close', code, null));
  }
  async waitFor(check: (line: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
    for (let i = 0; i < 400; i++) {
      const line = this.received.find(check);
      if (line) return line;
      await new Promise((r) => setTimeout(r, 2));
    }
    throw new Error(`the runner never received the line; got ${JSON.stringify(this.received)}`);
  }
}
