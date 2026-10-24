// The Cursor harness's permissions, compiled from the session's policy
// (docs/adapters.md, Cursor). Print mode has no channel on which a tool call
// waits for a human, so the policy cannot be asked per call as it is for
// Claude Code. It is written down instead, as Cursor's permissions file
// (`.cursor/cli.json`, documented at cursor.com/docs/cli/reference/permissions):
//   - deny, which wins over allow in Cursor: the credential file, the
//     environment files, /proc/*/environ, the git, Claude and Cursor folders,
//     the generated CLAUDE.md, and the commands the policy never lets run;
//   - allow, narrow: reads in the checkout, and (for an author whose plan is
//     approved) writes in it and the safe commands the policy names, word by
//     word. Anything else is not allowed, and `--force` is never passed, so
//     Cursor itself refuses it.
// The adapter then checks every call Cursor reports against the full policy
// (cursor.ts), the second layer, which stops a turn on a call the file let by.
import type { Policy } from '../../policy.ts';

export type CursorPermissions = { readonly permissions: { readonly allow: readonly string[]; readonly deny: readonly string[] } };

// What no session reads or writes, whatever its role.
const DENIED_READS = ['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '/proc/*/environ', '/proc/**/environ'] as const;
const DENIED_WRITES = ['**/.git/**', '**/.claude/**', '**/.cursor/**', '**/CLAUDE.md', '**/.env', '**/.env.*'] as const;
const DENIED_SHELLS = ['printenv', 'env', 'sudo', 'curl', 'wget', 'ssh', 'scp', 'nc', 'docker'] as const;

// `git commit *` becomes `Shell(git:commit *)`: the first word, then the rest.
function shellToken(pattern: string): string | undefined {
  const words = pattern.trim().split(/\s+/).filter(Boolean);
  const [first, ...rest] = words;
  if (first === undefined || first === '*' || first.includes('*')) return undefined;
  return rest.length === 0 ? `Shell(${first})` : `Shell(${first}:${rest.join(' ')})`;
}

export function cursorPermissions(policy: Policy): CursorPermissions {
  const deny: string[] = [
    ...DENIED_READS.map((glob) => `Read(${glob})`),
    ...DENIED_WRITES.map((glob) => `Write(${glob})`),
    ...DENIED_SHELLS.map((word) => `Shell(${word})`),
  ];
  if (policy.credentialFile) deny.push(`Read(${policy.credentialFile})`, `Write(${policy.credentialFile})`);
  const allow: string[] = [`Read(${policy.workdir}/**)`];
  const writes = policy.role === 'author' && policy.planning !== true;
  if (writes) allow.push(`Write(${policy.workdir}/**)`);
  else if (policy.planning === true) allow.push(`Write(${policy.workdir}/HANDOVER.md)`);
  if (policy.role !== 'lead') {
    const commands = [...policy.safeCommands, ...policy.scripts.map((script) => (script === 'test' ? 'npm test' : `npm run ${script}`))];
    for (const pattern of commands) {
      const token = shellToken(pattern);
      if (token !== undefined && !deny.includes(token)) allow.push(token);
    }
  }
  return { permissions: { allow: [...new Set(allow)], deny: [...new Set(deny)] } };
}
