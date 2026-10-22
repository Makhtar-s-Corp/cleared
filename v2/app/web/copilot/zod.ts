// Imported first by the CopilotKit modules of the page: zod (which
// CopilotKit and AG-UI validate events with) compiles its object parsers
// with `new Function` when it may, and probes for it once. The page runs
// under default-src 'self', without 'unsafe-eval', so the probe would be a
// reported violation. Without JIT, zod parses the same, a little slower.
import { config } from 'zod';

config({ jitless: true });
