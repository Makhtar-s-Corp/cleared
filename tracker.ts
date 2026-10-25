#!/usr/bin/env node
// The entry point to the configured ticket tracker ([tracker] adapter =
// linear | github | local), as tracker.sh and lib/tracker/adapters/dispatch.sh
// were (docs/v2/milestone-4-plan.md, step b): Linear through
// lib/tracker/adapters/linear.ts, GitHub and the local store through
// lib/tracker/cli.mjs. A comment of the GitHub and local trackers is posted
// here, under the hourly limit, with the agents' first line.
//
//   tracker.ts <command> [<argument>...]
//   tracker.ts legacy-line-allowed     exit 0 when a line of the user written before the statuses may count (Linear)
//   tracker.ts ticket-prefix           the prefix of the tracker's ticket identifiers
//   tracker.ts comment <ticket> <file|-> [sender]
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agoUtc, confGet, confSoft, die, hasText, lockFile, main, nowUtc, ORCH_HOME, ownerName, projectEnv, say, scratchDir, scriptName, userMessage } from './lib/script.ts';

// What the command it hands over to says and exits with, as `exec` gave it.
function handOver(program: string, args: readonly string[]): number {
  const run = spawnSync(program, [...args], { stdio: 'inherit', env: process.env });
  return run.status ?? 1;
}

await main(() => {
  const args = process.argv.slice(2);
  const { state } = projectEnv();
  const adapter = confGet('tracker', 'adapter');
  if (!adapter) die('Missing required [tracker] adapter (linear | github | local)');
  if (args[0] === 'legacy-line-allowed') return adapter === 'linear' ? 0 : 1;
  if (args[0] === 'ticket-prefix') {
    if (adapter === 'linear') process.stdout.write(`${confSoft('tracker', 'team')}\n`);
    else if (adapter === 'github') process.stdout.write('GH\n');
    else if (adapter === 'local') process.stdout.write('LOCAL\n');
    else die(`unknown [tracker] adapter: ${adapter}`);
    return 0;
  }
  if (args[0] === 'comment' && adapter !== 'linear') {
    if (args.length < 3) die('usage: tracker.ts comment <ticket> <file|-> [sender]');
    let input = args[2]!;
    const taken = input === '-' ? scratchDir('cleared-comment-') : null;
    const formatted = scratchDir('cleared-formatted-');
    try {
      if (taken) { input = join(taken.path, 'text'); writeFileSync(input, readFileSync(0)); }
      if (!existsSync(input) || !statSync(input).isFile() || !hasText(readFileSync(input, 'utf8'))) die('nothing to post');
      mkdirSync(state, { recursive: true });
      const lock = lockFile(join(state, 'tracker-comments.lock'), 60);
      if (!lock) die('another comment is being posted for too long');
      try {
        const setting = confSoft('tracker', 'comments_per_hour');
        const limit = /^[0-9]+$/.test(setting) ? Number(setting) : 6;
        const since = agoUtc(3600_000);
        let recent = 0;
        try {
          for (const line of readFileSync(join(state, 'tracker-comments.jsonl'), 'utf8').split('\n')) {
            try { const entry = JSON.parse(line) as { at?: unknown }; if (typeof entry?.at === 'string' && entry.at > since) recent += 1; } catch { /* not an entry */ }
          }
        } catch { /* none kept yet */ }
        if (recent >= limit) {
          say(`${scriptName()}: the user was already written ${recent} times in the last hour (limit: ${limit}): nothing posted`);
          return 4;
        }
        const from = args[3] || process.env.ORCH_SIGNED || 'script';
        const file = join(formatted.path, 'comment.md');
        writeFileSync(file, `${userMessage('agent_comment', { from, owner: ownerName(), body: readFileSync(input, 'utf8').replace(/\n+$/, '') })}\n`);
        const posted = spawnSync(process.execPath, ['--no-warnings', join(ORCH_HOME, 'lib', 'tracker', 'cli.mjs'), 'comment-json', args[1]!, file], { env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
        if (posted.status !== 0) return posted.status ?? 1;
        const answer = JSON.parse(posted.stdout) as { id?: unknown; url?: unknown };
        appendFileSync(join(state, 'tracker-comments.jsonl'), `${JSON.stringify({ id: String(answer.id ?? 'null'), ticket: args[1], from, at: nowUtc() })}\n`);
        process.stdout.write(`${answer.url === undefined || answer.url === null ? 'null' : String(answer.url)}\n`);
        return 0;
      } finally {
        lock.release();
      }
    } finally {
      taken?.remove();
      formatted.remove();
    }
  }
  if (adapter === 'linear') return handOver(join(ORCH_HOME, 'lib', 'tracker', 'adapters', 'linear.ts'), args);
  if (adapter === 'github' || adapter === 'local') return handOver(process.execPath, ['--no-warnings', join(ORCH_HOME, 'lib', 'tracker', 'cli.mjs'), ...args]);
  die(`unknown [tracker] adapter: ${adapter}`);
});
