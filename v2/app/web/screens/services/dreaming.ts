// The nightly pass panel's rules (issue #455): a service's last pass in
// words, a refusal in words. No React here, so the node tests read it.
import type { DreamingView } from '../../../../src/api/types.ts';
import type { Translate } from '../../lib/i18n.ts';
import { dayOf } from '../setup/model.ts';

// The service's routes through the app's proxy, which adds /api/service.
export const DREAMING_PATH = '/dreaming';

type Last = DreamingView['services'][number]['last'];

export function lastPassLine(last: Last, t: Translate): string {
  if (!last) return t('dreaming_never');
  const date = dayOf(last.at, t);
  if (last.outcome === 'quota') return t('dreaming_last_quota', { date });
  return t(last.proposed === 1 ? 'dreaming_last_one' : 'dreaming_last_other', { date, n: last.proposed });
}

// 403: only the owner turns it on or off; anything else as the general one.
export const dreamingRefusal = (t: Translate, status: number): string => t(status === 403 ? 'dreaming_error_owner' : 'dreaming_error_other');
