// A fake GitHub on loopback, port 0, for the browser tests of the checks
// step: what the forge step reads (GET /user/repos) and what the ready
// section reads (GET /user, GET /repos/{repo}). A credential it does not
// know is answered 401, as GitHub answers.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export class FakeGitHubForChecks {
  readonly paths: string[] = [];
  readonly #repos: ReadonlyMap<string, readonly string[]>;
  #server: Server | undefined;

  constructor(accounts: Readonly<Record<string, readonly string[]>>) {
    this.#repos = new Map(Object.entries(accounts));
  }

  async listen(): Promise<string> {
    this.#server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://fake');
      this.paths.push(url.pathname);
      const send = (status: number, body: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(body));
      };
      const repos = this.#repos.get((request.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (!repos) return send(401, { message: 'Bad credentials' });
      if (url.pathname === '/user') return send(200, { login: 'cleared-bot' });
      if (url.pathname === '/user/repos') return send(200, repos.map((name) => ({ full_name: name })));
      const repo = url.pathname.replace(/^\/repos\//, '');
      if (repos.includes(repo)) return send(200, { full_name: repo, permissions: { push: true } });
      send(404, { message: 'Not Found' });
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.#server?.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    this.#server?.closeAllConnections();
    await new Promise<void>((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
  }
}
