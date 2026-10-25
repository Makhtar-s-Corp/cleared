// The assistant's checks step (docs/v2/milestone-5-plan.md, sections 1 and
// 7, step 8): the ready section of `cleared doctor`, run by the service in
// the person's language, each line passed, failed with what to do, or a
// notice. The run counts as the machine's time; the step is done when no
// line failed. A person may skip it: the steps before it that a later lane
// fills (the workspace, the environment) are skipped too while they are stubs.
//
//   POST /api/setup/checks   { language: 'en' | 'fr' } -> ChecksView
//        (another language, or none: the app's, CLEARED_V2_APP_LANGUAGE)
//
// The checks reach Docker and the disk through probes, the machine's by
// default, and GitHub through the module's fetch; the tests give fakes
// (checksStep).
import type { Language } from '../../../app/src/catalog.ts';
import { languageOf } from '../../cli/cleared.ts';
import { readyChecks, realProbes, type ReadyProbes } from '../../doctor/ready.ts';
import type { ChecksView } from '../../doctor/types.ts';
import { answer, guarded, readBody } from '../http.ts';
import type { SetupStep, StepDeps } from '../step.ts';

export function checksStep(probes: (deps: StepDeps) => ReadyProbes = (deps) => ({ ...realProbes(), fetch: deps.fetch })): SetupStep {
  return {
    id: 'checks',
    filled: true,
    skippable: true,
    routes: (deps) => [
      {
        method: 'POST', path: '/api/setup/checks',
        handle: guarded(deps, async (context) => {
          const asked = (await readBody(context.request)).language;
          const language: Language = asked === 'en' || asked === 'fr' ? asked : languageOf(deps.env);
          const started = Date.now();
          const lines = await readyChecks({ env: deps.env, language, probes: probes(deps) });
          const tookMs = Date.now() - started;
          deps.records.machine('checks', tookMs);
          const failed = lines.filter((line) => line.level === 'fail').length;
          if (failed === 0) deps.records.done('checks');
          answer(context, 200, { lines, failed, tookMs } satisfies ChecksView);
        }),
      },
    ],
  };
}

export default checksStep();
