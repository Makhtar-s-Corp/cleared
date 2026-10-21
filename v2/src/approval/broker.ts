// The service's client of the release broker (serve/release-broker.mjs), over
// its Unix socket, with the same checks release-request.mjs makes before it
// connects. The broker takes the caller's uid from the kernel, never from the
// request: the service's own uid is accepted because the example project sets
// [security] allow_shared_uid = true (plan, decision 7), and no session
// container can reach the socket.
import net from 'node:net';
import { lstatSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type ReleaseBrokerRequest = {
  readonly ticket: string;
  readonly pr: number;
  readonly announcement: string;                  // what changes, where to see it, how to check: merge-pr.sh refuses a go-live without it
};

export type BrokerAnswer = {
  readonly ok: boolean;
  readonly output: string;
  readonly reason: string;
  readonly problem?: string | null;
};

export interface ReleaseBroker {
  requestRelease(request: ReleaseBrokerRequest): Promise<BrokerAnswer>;
}

const PLAIN = { ok: false, output: '' } as const;

export class SocketReleaseBroker implements ReleaseBroker {
  readonly #socket: string;
  readonly #stateDir: string;

  constructor(socket: string, options: { readonly stateDir: string }) {
    this.#socket = socket;
    this.#stateDir = options.stateDir;
  }

  // The socket must be one, owned by whoever owns the state directory.
  #checkSocket(): string | undefined {
    try {
      const socket = lstatSync(this.#socket);
      if (!socket.isSocket() || socket.uid !== statSync(this.#stateDir).uid) return 'the socket is not owned by the service account';
      return undefined;
    } catch (error) {
      return (error as Error).message;
    }
  }

  async #send(request: Record<string, unknown>, timeoutMs: number): Promise<BrokerAnswer> {
    const unsafe = this.#checkSocket();
    if (unsafe) return { ...PLAIN, reason: `release broker is not running or its socket is unsafe (${unsafe})` };
    return new Promise((resolve) => {
      const client = net.connect(this.#socket);
      let reply = '';
      let done = false;
      const finish = (answer: BrokerAnswer) => { if (!done) { done = true; client.destroy(); resolve(answer); } };
      client.setTimeout(timeoutMs, () => finish({ ...PLAIN, reason: 'release broker did not answer in time' }));
      client.setEncoding('utf8');
      client.on('connect', () => client.end(JSON.stringify(request)));
      client.on('data', (chunk) => { if (reply.length < 1_000_000) reply += chunk; });
      client.on('error', (error) => finish({ ...PLAIN, reason: `release broker unavailable: ${error.message}` }));
      client.on('end', () => {
        try {
          const result = JSON.parse(reply) as { ok?: boolean; output?: unknown; reason?: unknown; problem?: unknown };
          finish({ ok: result.ok === true, output: String(result.output ?? ''), reason: String(result.reason ?? ''), ...(result.problem !== undefined ? { problem: result.problem === null ? null : String(result.problem) } : {}) });
        } catch {
          finish({ ...PLAIN, reason: 'invalid release broker reply' });
        }
      });
    });
  }

  // `request_release` without --ask: the broker runs merge-pr.sh, which merges
  // when every check holds. Minutes, not seconds.
  requestRelease(request: ReleaseBrokerRequest): Promise<BrokerAnswer> {
    return this.#send({ operation: 'request_release', ticket: request.ticket, pr: request.pr, announcement: request.announcement }, 15 * 60_000);
  }

  // `request_release --ask`: the broker runs ask-validation.sh, which only
  // writes the request on the local tracker and keeps what was shown.
  requestApproval(request: { readonly ticket: string; readonly pr: number; readonly request: string; readonly prs?: readonly number[] }): Promise<BrokerAnswer> {
    const prs = [request.pr, ...(request.prs ?? []).filter((n) => n !== request.pr)];
    return this.#send({ operation: 'request_release', ticket: request.ticket, pr: request.pr, announcement: '', approval_request: request.request, approval_prs: prs, captures: [] }, 120_000);
  }

  status(ticket: string): Promise<BrokerAnswer> {
    return this.#send({ operation: 'status', ticket }, 30_000);
  }
}

// Where the broker listens, as release-request.mjs finds it.
export function brokerSocketPath(options: { readonly env: NodeJS.ProcessEnv; readonly confSocket?: string | undefined; readonly stateDir: string }): string {
  return options.env.CLEARED_RELEASE_SOCKET || options.confSocket || join(options.stateDir, 'release.sock');
}
