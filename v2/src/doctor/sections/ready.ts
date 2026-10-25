// The ready section (docs/v2/milestone-5-plan.md, section 7): the default of
// `cleared doctor`, and `node scripts/doctor.ts ready`. The checks are
// ../ready.ts's, against this machine.
import type { DoctorSection } from '../section.ts';
import { readyChecks, readyTranslator } from '../ready.ts';

const ready: DoctorSection = {
  name: 'ready',
  byDefault: true,
  title: (language) => readyTranslator(language)('section_title'),
  run: (env, language) => readyChecks({ env, language }),
};

export default ready;
