// What a proof receipt's captures need of a service (issue #505): `health_url`,
// whose origin the capture "before" opens, and `run`, the Dockerfile and the port
// of the trial the capture "after" opens (flow/proof-capture.ts). No step of the
// assistant asked for them, so a Compose install's receipts had no capture.
//
// They are read from the base of the repository when it says them: its
// `[release] health_url`, and the first EXPOSE of its Dockerfile. A folder of a
// monorepo reads its own files first. What is found is a proposal: only a person's
// confirmation writes it, since the address the release watches may not be one
// this machine can open. Nothing found is said as nothing, never guessed.
import { CheckoutError, git } from './checkout.ts';
import { parseConf } from './config.ts';

export type ReceiptTargets = { readonly healthUrl: string | null; readonly run: string | null };

const fileAt = async (dir: string, ref: string, path: string): Promise<string | undefined> => {
  try {
    return await git(dir, ['show', `${ref}:${path}`]);
  } catch (error) {
    if (error instanceof CheckoutError) return undefined;
    throw error;
  }
};

// An address the capture can open: http or https, with no name or password in it.
export function usableAddress(text: string): boolean {
  if (/[\r\n\0\s]/.test(text)) return false;
  try {
    const url = new URL(text);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

function releaseAddress(conf: string | undefined): string | null {
  if (conf === undefined) return null;
  let address: string | undefined;
  try { address = parseConf(conf).release?.health_url; } catch { return null; }
  return address && usableAddress(address) ? address : null;
}

function firstPort(dockerfile: string | undefined): number | null {
  const port = dockerfile?.split('\n').map((line) => /^\s*EXPOSE\s+(\d{1,5})(?:\/(?:tcp|udp))?(?:\s|$)/i.exec(line)?.[1]).find(Boolean);
  const number = Number(port);
  return port && number >= 1 && number <= 65535 ? number : null;
}

export async function detectReceiptTargets(source: { readonly dir: string; readonly base: string; readonly path: string | null }): Promise<ReceiptTargets> {
  const ref = `refs/remotes/origin/${source.base}`;
  const inFolder = (file: string) => (source.path === null ? file : `${source.path}/${file}`);
  const own = await fileAt(source.dir, ref, inFolder('.cleared/agents.conf'));
  const healthUrl = releaseAddress(own) ?? (source.path === null ? null : releaseAddress(await fileAt(source.dir, ref, '.cleared/agents.conf')));
  const port = firstPort(await fileAt(source.dir, ref, inFolder('Dockerfile')));
  return { healthUrl, run: port === null ? null : `Dockerfile:${port}` };
}

const BREAK = /[\r\n\0]/;

// The workspace file with these two keys of one service set, or taken out when
// empty; every other line stays as it was. The caller reads the text back as the
// service would before it writes it.
export function withReceiptTargets(text: string, service: string, targets: ReceiptTargets): string {
  if ((targets.healthUrl && BREAK.test(targets.healthUrl)) || (targets.run && BREAK.test(targets.run))) throw new Error('a value holds a line break');
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === `[service ${service}]`);
  if (start < 0) throw new Error(`no section for ${service}`);
  const after = lines.slice(start + 1).findIndex((line) => line.trim().startsWith('['));
  const end = after < 0 ? lines.length : start + 1 + after;
  const kept = lines.slice(start + 1, end).filter((line) => !/^\s*(?:health_url|run)\s*=/.test(line));
  // Added after the section's last line, before the blank lines that part it from the next.
  let last = kept.length;
  while (last > 0 && (kept[last - 1] as string).trim() === '') last -= 1;
  const added = [...(targets.healthUrl ? [`health_url = ${targets.healthUrl}`] : []), ...(targets.run ? [`run = ${targets.run}`] : [])];
  return [...lines.slice(0, start + 1), ...kept.slice(0, last), ...added, ...kept.slice(last), ...lines.slice(end)].join('\n');
}
