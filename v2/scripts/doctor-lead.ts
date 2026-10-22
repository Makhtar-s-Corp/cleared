// The checks of the doctor's `lead` section (docs/v2/milestone-2-plan.md,
// lanes 4 and 5): doctor.ts imports this list and runs it when the section
// is named. One check: a real generation of the lead on this server, in a
// container labelled cleared.dev=v2, on the doctor's model (claude-haiku-5-5
// by default), with one owner message, one commit, a refresh forced by a
// threshold of 2 % (so it comes after the first real turn, regardless of
// actual token window size), and the next generation answering a question
// about the commitment from its briefing.
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
    const lead = new LeadEngine({
      store: { db: store.db, events: log, sessions: store.sessions }, inbox: new InboxStore(store.db), flow: quietFlow(),
      adapter: createClaudeCodeAdapter({ log, runtime, cleaner: () => createCleaner({ servicePaths: [runtime.stateDir, homedir(), scratch] }) }),
      config: { enabled: true, model, contextPercent: 2, handoverPercent: 1, batchMs: 60_000 },
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
      say(`generation 1 idle, context ${JSON.stringify(lead.state().context)}`);
      await lead.post('Promise me that tomorrow at 08:00 you will remind me to check the texts of the page. Record it with the commit tool, then answer in one sentence.', 'doctor');
      if (!await until(() => lead.store.openCommitments().length > 0, 240_000)) return { ok: false, detail: 'no commitment was recorded: is lane 4\'s runner in the image?' };
      const commitment = lead.store.openCommitments()[0];
      say(`commitment ${commitment?.id}: ${commitment?.text}`);
      if (!await until(() => lead.state().generation === 2 && lead.state().phase === 'idle', 300_000)) return { ok: false, detail: `no refresh at 5 % (generation ${lead.state().generation}, ${lead.state().phase})` };
      say(`generation 2 idle after a refresh; handover ${JSON.stringify(lead.memory().handover)}`);
      const before = lead.messages().length;
      await lead.post('Which commitment do you have open? Give its id and what it says.', 'doctor');
      if (!await until(() => lead.messages().slice(before).some((m) => m.by === 'lead'), 240_000)) return { ok: false, detail: 'the second generation did not answer' };
      const reply = lead.messages().slice(before).find((m) => m.by === 'lead')?.text ?? '';
      say(`reply of generation 2: ${reply.slice(0, 300)}`);
      const named = commitment !== undefined && reply.includes(commitment.id);
      return named ? { ok: true, detail: `highest share ${lead.state().highestPercent} %` } : { ok: false, detail: 'the answer does not name the commitment' };
    } finally {
      await lead.stop();
      await lead.close();
      store.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  },
};

export const leadChecks: readonly DoctorLeadCheck[] = [realGeneration];
