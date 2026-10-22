// The lead's settings (docs/v2/milestone-2-plan.md, lane 5), from the
// service's environment. The lead is on when the service runs a project
// (CLEARED_V2_PROJECT), unless CLEARED_V2_LEAD_ENABLED turns it off; a
// setting that is set but wrong is an error, not a silent default.

export class LeadConfigError extends Error {
  override name = 'LeadConfigError';
}

export type LeadConfig = {
  readonly enabled: boolean;
  readonly model: string;                    // CLEARED_V2_LEAD_MODEL (decision 13)
  readonly contextPercent: number;           // the threshold: the turn is interrupted and the lead hands over
  readonly handoverPercent: number;          // the handover point: the lead hands over at the end of the turn
  readonly batchMs: number;                  // the flow's events are batched for this long into one turn
};

function percent(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 100) throw new LeadConfigError(`${name} must be a share in percent, above 0 and at most 100, not "${value}"`);
  return number;
}

export function loadLeadConfig(env: NodeJS.ProcessEnv = process.env): LeadConfig {
  const switched = (env.CLEARED_V2_LEAD_ENABLED ?? '').trim().toLowerCase();
  if (!['', 'on', '1', 'true', 'off', '0', 'false'].includes(switched)) throw new LeadConfigError(`CLEARED_V2_LEAD_ENABLED is on or off, not "${env.CLEARED_V2_LEAD_ENABLED}"`);
  const model = env.CLEARED_V2_LEAD_MODEL || 'claude-opus-5-5';
  if (!/^claude-[a-z0-9-]+-\d/.test(model)) throw new LeadConfigError(`CLEARED_V2_LEAD_MODEL must be an explicit model name such as claude-opus-5-5, not "${model}"`);
  const contextPercent = percent(env.CLEARED_V2_LEAD_CONTEXT_PERCENT, 'CLEARED_V2_LEAD_CONTEXT_PERCENT', 50);
  const handoverPercent = percent(env.CLEARED_V2_LEAD_HANDOVER_PERCENT, 'CLEARED_V2_LEAD_HANDOVER_PERCENT', Math.min(40, contextPercent * 0.8));
  if (handoverPercent >= contextPercent) throw new LeadConfigError(`CLEARED_V2_LEAD_HANDOVER_PERCENT (${handoverPercent}) must be below CLEARED_V2_LEAD_CONTEXT_PERCENT (${contextPercent})`);
  const seconds = env.CLEARED_V2_LEAD_BATCH_SECONDS;
  let batchMs = 60_000;
  if (seconds !== undefined && seconds !== '') {
    const number = Number(seconds);
    if (!Number.isInteger(number) || number <= 0) throw new LeadConfigError(`CLEARED_V2_LEAD_BATCH_SECONDS must be a positive whole number, not "${seconds}"`);
    batchMs = number * 1000;
  }
  return { enabled: !!env.CLEARED_V2_PROJECT && !['off', '0', 'false'].includes(switched), model, contextPercent, handoverPercent, batchMs };
}
