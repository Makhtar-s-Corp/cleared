// The images section (docs/v2/milestone-5-plan.md, section 10, matrix C15):
// `node scripts/doctor.ts images`, not run by default since it starts a
// container. Each service of the workspace: its prepared image ready for
// what its base holds now, with its age and its build's time; none yet,
// stale, being built, or failed with what to do. Then one session started
// on the newest ready image, labelled as every session is, running one
// line of Node, and the time from its start to that line measured against
// the 10-second target (decision 13); every object it made is removed. It
// builds nothing, and the session has no login: an empty file is mounted.
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Language } from '../../../app/src/catalog.ts';
import { ago, lasted } from '../../../app/web/lib/time.ts';
import { Docker } from '../../container/docker.ts';
import { PreparedError, preparedTag, readInputs, readRecord, stateDirOf } from '../../container/prepared.ts';
import { removeSessionVolume, sessionNames, startSession, stopSession } from '../../container/session-runtime.ts';
import { FlowConfigError, loadFlowConfig, workspaceOf } from '../../flow/config.ts';
import { doctorTranslator, type DoctorLevel, type DoctorLine, type DoctorSection } from '../section.ts';

export const START_TARGET_MS = 10_000;
const FIRST_LINE_TIMEOUT_MS = 60_000;

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 300);

export async function imagesChecks(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly language: Language;
  readonly docker?: Docker;
  readonly now?: () => Date;
  readonly clock?: () => number;                   // milliseconds: the measure's
}): Promise<DoctorLine[]> {
  const t = doctorTranslator('images', input.language);
  const docker = input.docker ?? new Docker();
  const now = (input.now ?? (() => new Date()))();
  const clock = input.clock ?? (() => performance.now());
  const lines: DoctorLine[] = [];
  const say = (id: string, level: DoctorLevel, key: string, values: Record<string, string | number> = {}, todo?: string) =>
    lines.push({ id, level, text: t(key, values), ...(todo ? { todo: t(todo, values) } : {}) });

  let config: ReturnType<typeof loadFlowConfig>;
  try {
    config = loadFlowConfig(input.env);
  } catch (error) {
    if (!(error instanceof FlowConfigError)) throw error;
    say('workspace', 'fail', 'workspace_fail', { reason: reasonOf(error) }, 'workspace_fail_todo');
    say('start', 'off', 'start_off');
    return lines;
  }
  if (!config) {
    say('workspace', 'notice', 'no_workspace', {}, 'no_workspace_todo');
    say('start', 'off', 'start_off');
    return lines;
  }

  const stateDir = stateDirOf(input.env);
  const ready: { readonly tag: string; readonly builtAt: string }[] = [];
  for (const service of workspaceOf(config).services) {
    const values = { service: service.name };
    const record = readRecord(stateDir, service.name);
    let hash: string | undefined;
    try {
      hash = (await readInputs({ service: service.name, dir: service.dir, base: service.base, path: service.path }))?.hash;
    } catch (error) {
      if (!(error instanceof PreparedError)) throw error;
      say('image', 'fail', 'image_failed', { ...values, reason: reasonOf(error) }, 'image_failed_todo');
      continue;
    }
    if (hash === undefined) say('image', 'notice', 'image_not_fetched', values, 'image_not_fetched_todo');
    else if (!record) say('image', 'notice', 'image_none', values, 'image_none_todo');
    else if (record.state === 'building') say('image', 'notice', 'image_building', { ...values, age: ago(record.startedAt ?? now.toISOString(), now, t) });
    else if (record.state === 'failed' && record.attempt === hash) say('image', 'fail', 'image_failed', { ...values, reason: record.error ?? '' }, 'image_failed_todo');
    else if (record.hash !== hash || !record.tag) say('image', 'notice', 'image_stale', values, 'image_stale_todo');
    else if (!(await docker.image(preparedTag(service.name, hash)))) say('image', 'notice', 'image_missing', { ...values, tag: record.tag }, 'image_none_todo');
    else {
      const builtAt = record.builtAt ?? now.toISOString();
      say('image', 'ok', 'image_ready', { ...values, tag: record.tag, age: ago(builtAt, now, t), took: lasted(record.buildMs ?? 0, t) });
      ready.push({ tag: record.tag, builtAt });
    }
  }

  const newest = ready.sort((a, b) => (a.builtAt < b.builtAt ? 1 : -1))[0];
  if (!newest) {
    say('start', 'off', 'start_off');
    return lines;
  }
  const values = { tag: newest.tag, target: lasted(START_TARGET_MS, t) };
  const session = randomUUID();
  const work = mkdtempSync(join(tmpdir(), 'cleared-v2-doctor-images-'));
  try {
    const workdir = join(work, 'work');
    mkdirSync(workdir);
    const tokenFile = join(work, 'no-login');
    writeFileSync(tokenFile, '', { mode: 0o600 });
    const began = clock();
    await startSession(docker, {
      session, workdir, tokenFile, allowDir: join(work, 'egress'), allowHosts: [], hostAddresses: [], services: [],
      user: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, image: newest.tag, readyPollMs: 100,
      command: ['node', '-e', 'console.log("ready")'],
    });
    const deadline = Date.now() + FIRST_LINE_TIMEOUT_MS;
    while (!(await docker.logs(session, sessionNames(session).container)).trim()) {
      if (Date.now() >= deadline) throw new Error(`no line within ${lasted(FIRST_LINE_TIMEOUT_MS, t)}`);
      await sleep(50);
    }
    const took = clock() - began;
    if (took < START_TARGET_MS) say('start', 'ok', 'start_ok', { ...values, took: lasted(took, t) });
    else say('start', 'notice', 'start_slow', { ...values, took: lasted(took, t) }, 'start_slow_todo');
  } catch (error) {
    say('start', 'fail', 'start_fail', { ...values, reason: reasonOf(error) }, 'start_fail_todo');
  } finally {
    await stopSession(docker, session).catch((error) => console.error(`cleared-v2: the doctor's session ${session} was not removed (${reasonOf(error)})`));
    await removeSessionVolume(docker, session).catch((error) => console.error(`cleared-v2: the doctor's session volume ${session} was not removed (${reasonOf(error)})`));
    rmSync(work, { recursive: true, force: true });
  }
  return lines;
}

const images: DoctorSection = {
  name: 'images',
  byDefault: false,
  title: (language) => doctorTranslator('images', language)('section_title'),
  run: (env, language) => imagesChecks({ env, language }),
};

export default images;
