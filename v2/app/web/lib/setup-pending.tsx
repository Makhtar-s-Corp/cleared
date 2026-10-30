// The service runs no ticket before the setup assistant connected a
// repository: it answers 503 (issue #431). A screen that reads tickets,
// sessions or the inbox then says the setup is not finished and links to
// the assistant, not an error. While the app waits for the service to make
// its proof, or refuses it (app/src/proxy.ts, issue #491), the screen says
// exactly that (serviceFailure).
import type { Translate } from './i18n.ts';
import { ApiError } from './screen.ts';

export const setupPending = (error: unknown): boolean => error instanceof ApiError && error.status === 503 && error.reason !== 'service_starting' && error.reason !== 'proof_refused';

// What a read that failed says: the app's own reasons exactly, else the screen's sentence.
export function serviceFailure(error: unknown, t: Translate, fallback: string): string {
  if (error instanceof ApiError && error.status === 503) {
    if (error.reason === 'service_starting') return t('service_starting');
    if (error.reason === 'proof_refused') return t('service_proof_refused', { reason: t(`proof_reason_${error.detail ?? 'malformed'}`) });
  }
  return fallback;
}

export function SetupPending({ t }: { readonly t: Translate }) {
  return (
    <div className="empty setup-pending" role="status">
      <p>{t('setup_pending')}</p>
      <a className="chip-button" href="/setup">{t('setup_pending_link')}</a>
    </div>
  );
}
