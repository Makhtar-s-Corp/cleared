// The checks of the doctor's `lead` section (docs/v2/milestone-2-plan.md,
// lanes 4 and 5): doctor.ts imports this list and runs it when the section
// is named. One check: a real generation of the lead on this server, in a
// container labelled cleared.dev=v2, on the doctor's model (claude-haiku-5-5
// by default), with one owner message, one commit, a refresh forced by
// thresholds derived from the generation's measured opening (deriveThresholds),
// and the next generation answering a question about the commitment from its
// briefing.
//
// It needs lane 4's runner (the host tools and the context line); before
// that runner is in the image, the commit never reaches the host and the
// check says so. The login is the doctor's own (docs/adapters.md): its file
// is never read here.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { INBOX_TABLE, InboxStore } from '../src/inbox/store.ts';
import { LEAD_TABLES } from '../src/lead/store.ts';
import { LeadEngine, type LeadFlow } from '../src/lead/engine.ts';
import { claudeCodeRuntime, createClaudeCodeAdapter } from '../src/session/adapters/claude-code.ts';
import { createCleaner } from '../src/session/clean.ts';
import { applyTables, openStore } from '../src/store/db.ts';
import { MemoryTicketStore } from '../src/tickets/contract.ts';

export type DoctorLeadContext = {
  readonly model: string;                         // the doctor's --model, claude-haiku-5-5 by default
  readonly build: boolean;                        // false with --no-build
  readonly say: (line: string) => void;           // a raw line, redacted as the doctor's own
};

export type DoctorLeadCheck = {
  readonly name: string;
  run(context: DoctorLeadContext): Promise<{ readonly ok: boolean; readonly detail?: string }>;
};

// The largest single answer the rules allow, in tokens (section 4.1).
export const ANSWER_TOKENS = 4_000;
// Generation 1 is refreshed this far past its opening: any real owner turn
// (the message, a commit call and its result, one sentence) adds more.
export const REFRESH_MARGIN_TOKENS = 100;
// Generation 2 is not refreshed again: no question turn adds this much.
export const QUIET_MARGIN_TOKENS = 20_000;

// The thresholds of a generation, from its measured opening: the handover
// point a margin past the opening, the threshold one largest answer past
// that, so the turn that crosses the handover point is not interrupted. In
// tokens, then as a share of the generation's window: the opening is a
// number of tokens (22 560 to 23 001 measured with claude-haiku-5-5), not a
// share, so a fixed percentage cannot follow the window.
export function deriveThresholds(opening: { readonly totalTokens: number; readonly maxTokens: number }, marginTokens: number): { handoverPercent: number; contextPercent: number } {
  const share = (tokens: number) => tokens / opening.maxTokens * 100;
  return { handoverPercent: share(opening.totalTokens + marginTokens), contextPercent: share(opening.totalTokens + marginTokens + ANSWER_TOKENS) };
}

// Tomorrow at 08:00 on this server, with its offset, as the commit tool
// wants it (a due time without an offset is refused, and the lead then asks).
export function tomorrowAtEight(now: Date): string {
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 8, 0, 0);
  const offset = -at.getTimezoneOffset();
  const pad = (n: number) => String(Math.abs(n)).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T08:00:00${offset < 0 ? '-' : '+'}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return true;
    await sleep(500);
  }
  return condition();
}

// A flow with no team: the lead alone, as on a quiet night.
const quietFlow = (): LeadFlow => ({
  subscribe: () => () => undefined,
  sessions: () => [],
  sessionDetail: () => undefined,
  eventsAfter: () => [],
  send: async () => { throw new Error('no team session runs in the doctor'); },
  answer: async () => { throw new Error('no team session runs in the doctor'); },
  registry: { ticketStore: new MemoryTicketStore() },
});

const realGeneration: DoctorLeadCheck = {
  name: 'a real lead generation: a commit, a forced refresh, the commitment answered from the briefing',
  async run({ model, say }) {
    const runtime = { ...claudeCodeRuntime(), maxBudgetUsd: 1, stopTimeoutMs: 20_000 };
    const scratch = mkdtempSync(join(tmpdir(), 'cleared-doctor-lead-'));
    const store = openStore(':memory:');
    applyTables(store.db, [INBOX_TABLE, ...LEAD_TABLES]);
    const log = {
      append: (entry: Parameters<typeof store.events.append>[0]) => {
        const event = store.events.append(entry);
        const e = event.event;
        if (e.type === 'CUSTOM') say(`event ${e.name} ${JSON.stringify(e.value).slice(0, 300)}`);
        else if (e.type === 'RUN_FINISHED') say(`event RUN_FINISHED ${JSON.stringify(e.result)}`);
        else if (e.type === 'RUN_ERROR') say(`event RUN_ERROR ${e.message.slice(0, 300)}`);
        else if (e.type === 'TEXT_MESSAGE_CONTENT') say(`event text ${e.delta.slice(0, 200).replace(/\s+/g, ' ')}`);
        return event;
      },
      after: store.events.after,
    };
    let workdirs = 0;
    // The engine reads its thresholds at each measure (#measured), so they
    // are set here once each generation's opening is measured. Until then the
    // service's defaults stand; an opening's own measure never refreshes.
    const config = { enabled: true, model, contextPercent: 50, handoverPercent: 40, batchMs: 60_000 };
    const derive = (generation: number, marginTokens: number): boolean => {
      const opening = lead.state().context;
      if (!opening) return false;
      Object.assign(config, deriveThresholds(opening, marginTokens));
      say(`generation ${generation} opening ${opening.totalTokens} of ${opening.maxTokens} tokens (${opening.percent} %): handover point ${config.handoverPercent.toFixed(4)} %, threshold ${config.contextPercent.toFixed(4)} %`);
      return true;
    };

    const lead = new LeadEngine({
      store: { db: store.db, events: log, sessions: store.sessions }, inbox: new InboxStore(store.db), flow: quietFlow(),
      adapter: createClaudeCodeAdapter({ log, runtime, cleaner: () => createCleaner({ servicePaths: [runtime.stateDir, homedir(), scratch] }) }),
      config,
      project: { name: 'doctor', base: 'main', workdir: join(scratch, 'lead') },
      effects: {
        async prepareWorkdir() {
          const dir = join(scratch, `lead-${++workdirs}`);
          mkdirSync(dir, { recursive: true });
          return dir;
        },
        async writeBriefing(workdir, text) { writeFileSync(join(workdir, 'CLAUDE.md'), text); say(`briefing of ${Buffer.byteLength(text)} bytes`); },
        async memory() { return [{ type: 'project', content: 'A project the doctor makes up: a guestbook page.' }]; },
        async searchMemory() { return []; },
      },
      settleMs: 5000,
    });
    try {
      await lead.start();
      if (!await until(() => lead.state().phase === 'idle', 240_000)) return { ok: false, detail: `the first generation did not become idle (${lead.state().phase})` };
      if (!derive(1, REFRESH_MARGIN_TOKENS)) return { ok: false, detail: 'the first generation\'s opening was not measured: is lane 4\'s runner in the image?' };

      const due = tomorrowAtEight(new Date());
      await lead.post(`Promise me that you will remind me to check the texts of the page at ${due}. Record it with the commit tool, with exactly that due time, then answer in one sentence. Do not ask me anything.`, 'doctor');
      if (!await until(() => lead.store.openCommitments().length > 0 || lead.state().pendingQuestion !== null, 240_000)) return { ok: false, detail: 'no commitment was recorded: is lane 4\'s runner in the image?' };
      if (lead.store.openCommitments().length === 0) return { ok: false, detail: 'the lead asked a question instead of recording the commitment' };
      const commitment = lead.store.openCommitments()[0];
      say(`commitment ${commitment?.id}: ${commitment?.text} (due ${commitment?.due})`);
      if (!await until(() => lead.state().generation === 2 && lead.state().phase === 'idle', 300_000)) return { ok: false, detail: `no refresh at the handover point ${config.handoverPercent.toFixed(4)} % (generation ${lead.state().generation}, ${lead.state().phase})` };
      say(`generation 2 idle after a refresh (${lead.state().refreshCount} so far); handover ${JSON.stringify(lead.memory().handover)}`);
      if (!derive(2, QUIET_MARGIN_TOKENS)) return { ok: false, detail: 'the second generation\'s opening was not measured' };

      const before = lead.messages().length;
      await lead.post('Which commitment do you have open? Give its id and what it says.', 'doctor');
      if (!await until(() => lead.messages().slice(before).some((m) => m.by === 'lead'), 240_000)) return { ok: false, detail: 'the second generation did not answer' };
      const reply = lead.messages().slice(before).find((m) => m.by === 'lead')?.text ?? '';
      const answeredBy = lead.state().generation;
      say(`reply of generation ${answeredBy}: ${reply.slice(0, 300)}`);
      if (answeredBy !== 2) return { ok: false, detail: `generation ${answeredBy} answered, not generation 2` };
      const named = commitment !== undefined && reply.includes(commitment.id);
      return named
        ? { ok: true, detail: `generation 1 refreshed into generation 2, which answered; refreshes ${lead.state().refreshCount}, highest share ${lead.state().highestPercent} %` }
        : { ok: false, detail: 'the answer does not name the commitment' };
    } finally {
      await lead.stop();
      await lead.close();
      store.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  },
};

export const leadChecks: readonly DoctorLeadCheck[] = [realGeneration];
