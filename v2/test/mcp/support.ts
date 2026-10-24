// A ledger with sessions and events to read, written by the service's own
// store in a folder of its own. Every value shaped like a secret is put
// together at run time, so that the guard, which reads this file, finds none.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/store/db.ts';
import type { AgUiEvent } from '../../src/session/events.ts';

export const SECRETS = {
  anthropic: ['sk', 'ant', 'api03', 'Q'.repeat(30)].join('-'),
  github: ['gh', 'p_', 'R'.repeat(36)].join(''),
  githubFine: ['github', 'pat', '11AAAA', 'B'.repeat(40)].join('_'),
  slack: ['xo', 'xb-', '1234567890-', 'C'.repeat(20)].join(''),
  linear: ['lin', 'api', 'D'.repeat(32)].join('_'),
  aws: ['AK', 'IA', 'E'.repeat(16)].join(''),
  jwt: ['ey' + 'J' + 'hbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'F'.repeat(20)].join('.'),
  bearer: 'G'.repeat(28),
  envToken: 'H'.repeat(24),
  envValue: 'value-from-the-environment-' + 'J'.repeat(8),
  privateKey: ['-----BEGIN', 'RSA PRIVATE', 'KEY-----\nMIIB', 'K'.repeat(40), '\n-----END RSA PRIVATE KEY-----'].join(' '),
  previewKey: 'P'.repeat(43),
} as const;

export const ENV_NAME = ['DEPLOY', 'SECRET'].join('_');

export type Fixture = { readonly dir: string; readonly path: string; close(): void };

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';
export const SESSIONS = { S1, S2, S3 } as const;

// S1: the author of LOCAL-7 in shop, on 2026-10-20, 1 h 30 long.
// S2: the reviewer of LOCAL-7 in shop, on 2026-10-21.
// S3: the author of LOCAL-9 in blog, on 2026-10-22.
export function makeLedger(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'cleared-v2-mcp-'));
  const path = join(dir, 'ledger.db');
  const store = openStore(path);
  const put = (id: string, project: string, ticket: string, role: 'author' | 'reviewer', createdAt: string, updatedAt: string, previewKey: string | null) =>
    store.sessions.put({ id, project, ticket, role, harness: 'claude-code', model: 'claude-sonnet-5-5', status: 'done', createdAt, updatedAt, service: 'web', previewKey });
  put(S1, 'shop', 'LOCAL-7', 'author', '2026-10-20T09:00:00.000Z', '2026-10-20T10:30:00.000Z', SECRETS.previewKey);
  put(S2, 'shop', 'LOCAL-7', 'reviewer', '2026-10-21T14:00:00.000Z', '2026-10-21T14:00:42.000Z', null);
  put(S3, 'blog', 'LOCAL-9', 'author', '2026-10-22T08:00:00.000Z', '2026-10-24T09:00:00.000Z', null);
  const add = (sessionId: string, ticket: string, project: string, at: string, event: AgUiEvent) => store.events.append({ sessionId, ticket, project, at, event });
  add(S1, 'LOCAL-7', 'shop', '2026-10-20T09:00:01.000Z', { type: 'STEP_STARTED', stepName: 'author' });
  add(S1, 'LOCAL-7', 'shop', '2026-10-20T09:05:00.000Z', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'msg_01AAAAAAAAAA', delta: 'The basket total now rounds to the cent.' });
  add(S1, 'LOCAL-7', 'shop', '2026-10-20T09:10:00.000Z', { type: 'TOOL_CALL_ARGS', toolCallId: 'toolu_01BBBBBBBBBB', delta: JSON.stringify({ kind: 'execute', command: `curl -H "Authorization: Bearer ${SECRETS.bearer}" https://api.example.com` }) });
  add(S1, 'LOCAL-7', 'shop', '2026-10-20T09:11:00.000Z', { type: 'TOOL_CALL_RESULT', messageId: 'msg_01CCCCCCCCCC', toolCallId: 'toolu_01BBBBBBBBBB', role: 'tool', content: JSON.stringify({ kind: 'execute', output: [
    `anthropic ${SECRETS.anthropic}`, `github ${SECRETS.github}`, `fine ${SECRETS.githubFine}`, `slack ${SECRETS.slack}`, `linear ${SECRETS.linear}`,
    `aws ${SECRETS.aws}`, `jwt ${SECRETS.jwt}`, `export ${['GITHUB', 'TOKEN'].join('_')}=${SECRETS.envToken}`, `env ${SECRETS.envValue}`, SECRETS.privateKey,
  ].join('\n'), cut: 0, isError: false }) });
  add(S1, 'LOCAL-7', 'shop', '2026-10-20T10:29:00.000Z', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'msg_01DDDDDDDDDD', delta: 'Long text: ' + 'x'.repeat(5000) });
  add(S2, 'LOCAL-7', 'shop', '2026-10-21T14:00:30.000Z', { type: 'CUSTOM', name: 'cleared.review_verdict', value: { session: S2, verdict: 'changes_requested', round: 1 } });
  add(S2, 'LOCAL-7', 'shop', '2026-10-21T14:00:31.000Z', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'msg_01EEEEEEEEEE', delta: 'Le total du panier doit être arrondi « au centime ».' });
  for (let i = 0; i < 30; i++)
    add(S3, 'LOCAL-9', 'blog', `2026-10-22T08:${String(i).padStart(2, '0')}:00.000Z`, { type: 'TEXT_MESSAGE_CONTENT', messageId: `msg_01F${String(i).padStart(10, '0')}`, delta: `post draft ${i}` });
  store.close();
  return { dir, path, close: () => rmSync(dir, { recursive: true, force: true }) };
}

// The environment the server reads its secrets from: the value of a
// variable whose name says it is a secret.
export const ENV: NodeJS.ProcessEnv = { [ENV_NAME]: SECRETS.envValue, HOME: '/home/nobody' };
