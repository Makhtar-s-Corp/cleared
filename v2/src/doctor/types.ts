// The checks step's answer (docs/v2/milestone-5-plan.md, section 3.1: each
// new module keeps its route types in its own types.ts), read by the
// service's checks step and by the app's setup screen.
import type { DoctorLine } from './section.ts';

export type { DoctorLevel, DoctorLine } from './section.ts';

// POST /api/setup/checks { language }: the ready section's lines in that
// language, how many failed, and how long the run took.
export type ChecksView = { readonly lines: readonly DoctorLine[]; readonly failed: number; readonly tookMs: number };
