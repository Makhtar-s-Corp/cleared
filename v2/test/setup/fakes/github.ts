// A fake of what the assistant's forge step asks GitHub, on loopback, port 0:
// GET /user/repos, a page of the repositories a credential reaches, and the
// two requests that say what it may do on one of them (forge/write-access.ts).
// Each credential is an account with its repositories; any other is answered
// 401, as GitHub answers a credential it does not know. A credential writes
// everywhere it reaches unless `denied` names what it may not: 403 there, and
// 422 otherwise, since those requests can never succeed.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export class FakeForge {
  readonly requests: { method: string; path: string; auth: string | undefined; version: string | undefined }[] = [];
  readonly #accounts: ReadonlyMap<string, readonly string[]>;
  #server: Server | undefined;
  status: number | undefined;                       // forces every answer's status (403, 500)
  // Per credential, the writes it may not do on any repository.
  readonly denied = new Map<string, ReadonlySet<'contents' | 'pulls'>>();

  constructor(accounts: Readonly<Record<string, readonly string[]>>) {
    this.#accounts = new Map(Object.entries(accounts));
  }

  async listen(): Promise<string> {
    this.#server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://fake');
      const auth = request.headers.authorization;
      const version = request.headers['x-github-api-version'];
      this.requests.push({ method: request.method ?? 'GET', path: `${url.pathname}${url.search}`, auth, version: typeof version === 'string' ? version : undefined });
      const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
        response.end(JSON.stringify(body));
      };
      if (this.status) return send(this.status, { message: 'forced' });
      const token = (auth ?? '').replace(/^Bearer /, '');
      const write = /^\/repos\/([^/]+\/[^/]+)\/(git\/refs|pulls)$/.exec(url.pathname);
      if (write && request.method === 'POST') {
        const reached = this.#accounts.get(token);
        if (!reached) return send(401, { message: 'Bad credentials' });
        if (!reached.includes(write[1] as string)) return send(404, { message: 'Not Found' });
        if (this.denied.get(token)?.has(write[2] === 'pulls' ? 'pulls' : 'contents')) return send(403, { message: 'Resource not accessible by personal access token' });
        return send(422, { message: 'Validation Failed' });
      }
      if (url.pathname !== '/user/repos' || request.method !== 'GET') return send(404, { message: 'Not Found' });
      const repos = this.#accounts.get(token);
      if (!repos) return send(401, { message: 'Bad credentials' });
      const perPage = Number(url.searchParams.get('per_page') ?? 30);
      const page = repos.slice(0, perPage).map((name) => ({ full_name: name, private: false }));
      send(200, page, repos.length > perPage ? { link: `<http://fake/user/repos?page=2>; rel="next"` } : {});
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.#server?.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    const server = this.#server;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
