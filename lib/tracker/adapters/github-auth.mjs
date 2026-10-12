import { execFileSync } from 'node:child_process';
import { createSign } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const REFRESH_BEFORE_MS = 5 * 60_000;
const encoded = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

function appKey(settings) {
  const path = settings.app_private_key_file;
  if (!path || !isAbsolute(path)) throw new Error('GitHub tracking requires an absolute [tracker] app_private_key_file');
  const info = statSync(path);
  if (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)
    throw new Error('The GitHub App private key must be owned by the Cleared account and have mode 0600');
  return readFileSync(path);
}

export function mintInstallationToken(settings, { now = () => Date.now(), request } = {}) {
  if (!/^[0-9]+$/.test(settings.app_id || '') || !/^[0-9]+$/.test(settings.installation_id || ''))
    throw new Error('GitHub tracking requires numeric [tracker] app_id and installation_id');
  const timestamp = Math.floor(now() / 1000);
  const message = `${encoded({ alg: 'RS256', typ: 'JWT' })}.${encoded({ iat: timestamp - 60, exp: timestamp + 540, iss: settings.app_id })}`;
  const signature = createSign('RSA-SHA256').update(message).sign(appKey(settings)).toString('base64url');
  const jwt = `${message}.${signature}`;
  const endpoint = `https://api.github.com/app/installations/${settings.installation_id}/access_tokens`;
  const ask = request || ((url, bearer) => {
    // Supply the JWT on stdin, never in process arguments or a shell command.
    const config = ['request = "POST"', 'silent', 'show-error', 'fail', 'max-time = 30',
      `header = "Authorization: Bearer ${bearer}"`, 'header = "Accept: application/vnd.github+json"',
      'header = "X-GitHub-Api-Version: 2022-11-28"'].join('\n');
    return JSON.parse(execFileSync('curl', ['--config', '-', url], { input: config, encoding: 'utf8', timeout: 35_000 }));
  });
  const result = ask(endpoint, jwt);
  if (!result?.token || !Number.isFinite(Date.parse(result.expires_at)) || Date.parse(result.expires_at) - now() <= REFRESH_BEFORE_MS)
    throw new Error('GitHub App returned an absent or nearly expired installation token');
  return { token: result.token, expiresAt: result.expires_at };
}

export class GithubAppTokens {
  constructor(settings, options = {}) {
    this.settings = settings;
    this.now = options.now || (() => Date.now());
    this.mint = options.mint || ((configured) => mintInstallationToken(configured, { now: this.now, request: options.request }));
    this.current = null;
  }
  get() {
    if (this.current && Date.parse(this.current.expiresAt) - this.now() > REFRESH_BEFORE_MS) return this.current.token;
    this.current = this.mint(this.settings);
    if (!this.current?.token || !Number.isFinite(Date.parse(this.current.expiresAt))
      || Date.parse(this.current.expiresAt) - this.now() <= REFRESH_BEFORE_MS)
      throw new Error('GitHub App returned an absent or nearly expired installation token');
    return this.current.token;
  }
}
