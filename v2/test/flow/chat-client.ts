// A fake chat client (P212): what a chat platform does with a slash
// command, without any account. It signs a command as Slack signs one (v0,
// HMAC-SHA256 of "v0:<timestamp>:<body>" with the shared secret, in
// x-slack-signature and x-slack-request-timestamp), sends it form-encoded to
// the service, and listens on a loopback port of its own for the replies
// the service posts later to the command's response_url.
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Posted = { readonly path: string; readonly body: Record<string, unknown> };

export type Command = {
  readonly text: string;
  readonly user?: string;                 // the chat's user id, U0TEST1 by default
  readonly responseUrl?: string | null;   // the fake's own reply address by default; null sends none
  readonly timestamp?: number;            // seconds; now by default
  readonly signature?: string | null;     // a signature of the caller's; null sends none
  readonly secret?: string;               // the client's secret by default
};

export type Answer = { readonly status: number; readonly json: Record<string, unknown> | undefined; readonly raw: string; readonly sent: { readonly body: string; readonly headers: Record<string, string> } };

export class FakeChatClient {
  readonly posted: Posted[] = [];
  #server: Server | undefined;
  #origin = '';
  #replies = 0;
  readonly #secret: string;
  readonly #now: () => number;

  constructor(options: { readonly secret: string; readonly now?: () => number }) {
    this.#secret = options.secret;
    this.#now = options.now ?? (() => Date.now());
  }

  // The reply server, on a free loopback port.
  async open(): Promise<void> {
    this.#server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(raw) as Record<string, unknown>; } catch { body = { unreadable: raw }; }
        this.posted.push({ path: request.url ?? '', body });
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('ok');
      });
    });
    await new Promise<void>((resolve) => this.#server!.listen(0, '127.0.0.1', resolve));
    this.#origin = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    this.#server?.closeAllConnections();
    await new Promise<void>((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
  }

  get origin(): string {
    return this.#origin;
  }

  // A new reply address, as the platform gives one per command.
  replyUrl(): string {
    this.#replies++;
    return `${this.#origin}/reply/${this.#replies}`;
  }

  // The body and headers of a command, signed unless told otherwise.
  sign(command: Command): { body: string; headers: Record<string, string> } {
    const responseUrl = command.responseUrl === undefined ? this.replyUrl() : command.responseUrl;
    const form = new URLSearchParams({ team_id: 'T0TEST', channel_id: 'C0TEST', user_id: command.user ?? 'U0TEST1', user_name: 'tester', command: '/cleared', text: command.text });
    if (responseUrl !== null) form.set('response_url', responseUrl);
    const body = form.toString();
    const timestamp = String(command.timestamp ?? Math.floor(this.#now() / 1000));
    const signature = command.signature === undefined
      ? `v0=${createHmac('sha256', command.secret ?? this.#secret).update(`v0:${timestamp}:${body}`).digest('hex')}`
      : command.signature;
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', 'x-slack-request-timestamp': timestamp };
    if (signature !== null) headers['x-slack-signature'] = signature;
    return { body, headers };
  }

  async send(url: string, command: Command): Promise<Answer> {
    return this.resend(url, this.sign(command));
  }

  // The same bytes and headers again: a replay.
  async resend(url: string, sent: { body: string; headers: Record<string, string> }): Promise<Answer> {
    const response = await fetch(url, { method: 'POST', headers: sent.headers, body: sent.body });
    const raw = await response.text();
    let json: Record<string, unknown> | undefined;
    try { json = raw ? JSON.parse(raw) as Record<string, unknown> : undefined; } catch { json = undefined; }
    return { status: response.status, json, raw, sent };
  }
}
