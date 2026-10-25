#!/usr/bin/env node
// Asks the user for his agreement to a go-live, the one way it is asked: a
// request on the ticket, in product language (what changes for the user of
// the app, why now, the question; a screenshot named when it is a screen),
// and the ticket put in the status that says "waits for you". He agrees by
// putting it in his own status of agreement; nothing here can do that.
//
//   ask-validation.ts <ticket> <file|-> --pr <pull request>... [--capture <image> [<caption>]]...
//
// - reads the request on stdin. He is asked for pull requests, at the version
// each is at now: the request ends with a line that says which, and
// state/validations/<ticket>.json keeps it. His agreement is to that
// version; merge-pr.ts puts nothing else live on it. Each capture is a
// screenshot set apart to be sent (tracker.ts upload says from which
// folder); it is shown under the request, with its caption. A change of
// screen is asked for with its capture, or not asked for.
//
// The port of ask-validation.sh (docs/v2/milestone-4-plan.md, step b): the
// same arguments, record, messages and exit codes. The two teams on one
// ticket, which only v1's lanes opened, are not carried over.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agoUtc, confGet, die, ghShown, hasText, lockFile, main, nowUtc, projectEnv, readJson, ScriptExit, scratchDir, tracker, userMessage, writeWhole } from './lib/script.ts';

const USAGE = 'usage: ask-validation.ts <ticket> <file|-> --pr <pull request>... [--capture <image> [<caption>]]...';

type Shown = { pr: number; head: string; [key: string]: unknown };

// The time of the request, written as `date -u +%Y-%m-%dT%H:%M:%S.%NZ` wrote
// it: nine digits after the second.
const requestTime = (): string => new Date().toISOString().replace(/\.(\d{3})Z$/, '.$1000000Z');

const same = (a: Shown, b: Shown): boolean => a.pr === b.pr && a.head === b.head;

await main(() => {
  const args = process.argv.slice(2);
  if (args.length < 2 || !/^[A-Z]+-[0-9]+$/.test(args[0]!)) die(USAGE);
  const { state } = projectEnv();
  const ticket = args[0]!;
  const source = args[1]!;
  const pulls: string[] = [];
  const captures: string[] = [];
  const captions: string[] = [];
  for (let i = 2; i < args.length;) {
    if (args[i] === '--pr') {
      if (!/^[0-9]+$/.test(args[i + 1] ?? '')) die(USAGE);
      pulls.push(args[i + 1]!);
      i += 2;
    } else if (args[i] === '--capture') {
      if (!args[i + 1]) die(USAGE);
      captures.push(args[i + 1]!);
      i += 2;
      if (i < args.length && args[i] !== '--capture' && args[i] !== '--pr') { captions.push(args[i]!); i += 1; } else captions.push('Capture');
    } else die(USAGE);
  }
  if (pulls.length === 0) die(USAGE);
  const work = scratchDir('cleared-ask-');
  try {
    const textFile = join(work.path, 'text');
    if (source === '-') writeFileSync(textFile, readFileSync(0));
    else {
      if (!existsSync(source) || !statSync(source).isFile()) die(`no such file: ${source}`);
      writeFileSync(textFile, readFileSync(source));
    }
    if (!hasText(readFileSync(textFile, 'utf8'))) die('nothing to ask');
    const validate = confGet('tracker', 'validate_state');
    // The version of each pull request, now.
    const shown: Shown[] = [];
    const versions: string[] = [];
    for (const pr of pulls) {
      const viewed = ghShown(['pr', 'view', pr, '--json', 'state,headRefOid']);
      if (viewed.status !== 0) die(`pull request #${pr} could not be read`);
      let pull: { state?: unknown; headRefOid?: unknown };
      try { pull = JSON.parse(viewed.stdout) as typeof pull; } catch { die(`pull request #${pr} could not be read`); }
      if (pull.state !== 'OPEN') die(`#${pr} is not open: nothing asked`);
      const head = String(pull.headRefOid ?? '');
      if (!/^[0-9a-f]{40}$/.test(head)) die(`the version of #${pr} could not be read`);
      shown.push({ pr: Number(pr), head });
      versions.push(userMessage('approval_pr_version', { pr, head: head.slice(0, 8) }));
    }
    // Asked once for a version: a ticket that already waits for him with these
    // very versions is not asked again. A version pushed since is a new request.
    // What he was shown before of the other pull requests of the ticket stays:
    // his agreement to them still stands.
    const kept = join(state, 'validations', `${ticket}.json`);
    // This record is also written by a go-live and by the wake: under the same
    // lock as them, from its reading to its writing.
    mkdirSync(join(state, 'validations'), { recursive: true });
    const wait = Number(process.env.ORCH_LOCK_WAIT || 60);
    const lock = lockFile(join(state, 'merge.lock'), Number.isFinite(wait) && wait > 0 ? wait : 60);
    if (!lock) die('a go-live is being done: nothing asked, ask again in a minute');
    try {
      const record = readJson<{ pulls?: unknown }>(kept);
      const before: Shown[] = Array.isArray(record?.pulls) ? (record.pulls as Shown[]) : [];
      const now = tracker(['state', ticket]).stdout.replace(/\n+$/, '');
      if (now === validate && shown.every((one) => before.some((was) => same({ pr: was.pr, head: was.head }, one)))) {
        die(`${ticket} already waits for the user in « ${validate} » for these versions: nothing asked again`);
      }
      const all = [...before.filter((was) => !shown.some((one) => one.pr === was.pr)), ...shown].sort((a, b) => a.pr - b.pr);
      // A request is made whole: its text on the ticket, the card moved, what was
      // shown kept. If the card cannot be moved once the text is written, nothing
      // is kept yet, the command says so, and the same request asked again within
      // the hour is finished without being written to him a second time. The note
      // of the request is taken before anything is written to him: when nothing
      // can be kept, nothing is asked. What this does not cover: a command stopped
      // between the comment and the mark that it was written (a kill, the host
      // going down) writes to him again when asked again.
      const pending = join(state, 'validations', `${ticket}.pending`);
      const request = createHash('sha256').update(Buffer.concat([readFileSync(textFile), Buffer.from(`${JSON.stringify(shown)}\n\n${captures.length > 0 ? captures.map((one) => `${one}\n`).join('') : '\n'}`)])).digest('hex');
      const note = (written: boolean): boolean => {
        try { writeWhole(pending, `${JSON.stringify({ request, at: nowUtc(), written }, null, 2)}\n`); return true; } catch { return false; }
      };
      const noted = readJson<{ at?: unknown; written?: unknown; request?: unknown }>(pending);
      const written = noted && String(noted.at ?? '') > agoUtc(3600_000) && noted.written === true ? String(noted.request ?? '') : '';
      if (written !== request) {
        if (!note(false)) die(`nothing can be kept in ${state}/validations: nothing asked, nothing written to the user. Repair the folder and ask again`);
        // The captures first: a request whose capture cannot be sent is not posted without it.
        captures.forEach((capture, index) => {
          const sent = tracker(['upload', capture]);
          if (sent.status !== 0) die(`the capture ${capture} could not be sent: nothing asked`);
          const caption = captions[index]!;
          appendFileSync(textFile, `\n\n**${caption}**\n\n![${caption}](${sent.stdout.replace(/\n+$/, '')})\n`);
        });
        // A request made again for a pull request says which version the one
        // before was about: the user sees that it is a new one.
        const earlier = shown.flatMap((one) => {
          const was = before.find((pull) => pull.pr === one.pr)?.head;
          return was && was !== one.head ? [String(was).slice(0, 8)] : [];
        }).join(', ');
        const previous = earlier ? ` ; ${userMessage('approval_previous_version', { heads: earlier })}` : '';
        appendFileSync(textFile, `\n\n${userMessage('approval_version', { versions: versions.join(', '), previous })}\n`);
        const posted = tracker(['comment', ticket, textFile, process.env.ORCH_SIGNED || confGet('lead', 'name')]);
        if (posted.status !== 0) throw new ScriptExit(posted.status);
        if (!note(true)) die(`the request is written on ${ticket}, but that could not be noted: the card is not moved and what he was shown is not kept. Asked again, it will be written to him a second time: repair ${state}/validations first`);
      }
      const moved = tracker(['move', ticket, validate]);
      process.stdout.write(moved.stdout);
      if (moved.status !== 0) die(`the request is written on ${ticket}, but the card could not be moved to « ${validate} »: nothing is kept yet. Ask again with the same request: it will be finished without being written to him a second time`);
      // What else the record holds (a ticket the wake still has to close) is kept.
      const old = record && typeof record === 'object' && !Array.isArray(record) ? record : {};
      const next: Record<string, unknown> = { ...old, ticket, at: requestTime(), pulls: all };
      delete next.teams;
      try { writeWhole(kept, `${JSON.stringify(next, null, 2)}\n`); } catch {
        die(`the card of ${ticket} is in « ${validate} », but what he was shown could not be kept in ${kept}: his agreement would be bound to no version, and no go-live will read it. Repair the folder and ask again with the same request: it will be finished without being written to him a second time`);
      }
      rmSync(pending, { force: true });
      return 0;
    } finally {
      lock.release();
    }
  } finally {
    work.remove();
  }
});
