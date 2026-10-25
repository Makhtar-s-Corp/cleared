import { execFileSync } from 'node:child_process';
import { createSign } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export type AppSettings = { app_id?: string; installation_id?: string; app_private_key_file?: string; readonly [key: string]: unknown };
export type InstallationToken = { token: string; expiresAt: string };
export type TokenRequest = (url: string, bearer: string) => unknown;
export type MintOptions = { now?: () => number; request?: TokenRequest; section?: string };
export type TokenOptions = MintOptions & { mint?: (settings: AppSettings) => InstallationToken };
type MintAnswer = { token?: string; expires_at: string };

const REFRESH_BEFORE_MS = 5 * 60_000;
const encoded = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

// What needs the app, by the section its keys were read from: the tracker,
// or the forge ([forge], or the tracker's keys lent to it).
const user = (section: string): string => section === 'tracker' ? 'GitHub tracking' : 'The GitHub App forge identity';

function appKey(settings: AppSettings, section: string): Buffer {
  const path = settings.app_private_key_file;
  if (!path || !isAbsolute(path)) throw new Error(`${user(section)} requires an absolute [${section}] app_private_key_file`);
  const info = statSync(path);
  if (info.uid !== process.getuid!() || (info.mode & 0o077) !== 0)
    throw new Error(section === 'tracker' ? 'The GitHub App private key must be owned by the Cleared account and have mode 0600'
      : `The GitHub App private key ([${section}] app_private_key_file) must be owned by the Cleared account and have mode 0600`);
  return readFileSync(path);
}

export function mintInstallationToken(settings: AppSettings, { now = () => Date.now(), request, section = 'tracker' }: MintOptions = {}): InstallationToken {
  if (!/^[0-9]+$/.test(settings.app_id || '') || !/^[0-9]+$/.test(settings.installation_id || ''))
    throw new Error(`${user(section)} requires numeric [${section}] app_id and installation_id`);
  const timestamp = Math.floor(now() / 1000);
  const message = `${encoded({ alg: 'RS256', typ: 'JWT' })}.${encoded({ iat: timestamp - 60, exp: timestamp + 540, iss: settings.app_id })}`;
  const signature = createSign('RSA-SHA256').update(message).sign(appKey(settings, section)).toString('base64url');
  const jwt = `${message}.${signature}`;
  const endpoint = `https://api.github.com/app/installations/${settings.installation_id}/access_tokens`;
  const ask = request || ((url: string, bearer: string): unknown => {
    // Supply the JWT on stdin, never in process arguments or a shell command.
    const config = ['request = "POST"', 'silent', 'show-error', 'fail', 'max-time = 30',
      `header = "Authorization: Bearer ${bearer}"`, 'header = "Accept: application/vnd.github+json"',
      'header = "X-GitHub-Api-Version: 2022-11-28"'].join('\n');
    return JSON.parse(execFileSync('curl', ['--config', '-', url], { input: config, encoding: 'utf8', timeout: 35_000 }));
  });
  const result = ask(endpoint, jwt) as MintAnswer | null | undefined;
  if (!result?.token || !Number.isFinite(Date.parse(result.expires_at)) || Date.parse(result.expires_at) - now() <= REFRESH_BEFORE_MS)
    throw new Error('GitHub App returned an absent or nearly expired installation token');
  return { token: result.token, expiresAt: result.expires_at };
}

export class GithubAppTokens {
  declare settings: AppSettings;
  declare now: () => number;
  declare mint: (settings: AppSettings) => InstallationToken;
  declare current: InstallationToken | null;
  constructor(settings: AppSettings, options: TokenOptions = {}) {
    this.settings = settings;
    this.now = options.now || (() => Date.now());
    this.mint = options.mint || ((configured: AppSettings) => mintInstallationToken(configured, { now: this.now, request: options.request, section: options.section }));
    this.current = null;
  }
  get(): string {
    if (this.current && Date.parse(this.current.expiresAt) - this.now() > REFRESH_BEFORE_MS) return this.current.token;
    this.current = this.mint(this.settings);
    if (!this.current?.token || !Number.isFinite(Date.parse(this.current.expiresAt))
      || Date.parse(this.current.expiresAt) - this.now() <= REFRESH_BEFORE_MS)
      throw new Error('GitHub App returned an absent or nearly expired installation token');
    return this.current.token;
  }
}
