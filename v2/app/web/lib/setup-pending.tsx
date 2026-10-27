// The service runs no ticket before the setup assistant connected a
// repository: it answers 503 (issue #431). A screen that reads tickets,
// sessions or the inbox then says the setup is not finished and links to
// the assistant, not an error. While the app waits for the service to make
// its proof (app/src/proxy.ts, service_starting), the screen's usual
// "tries again" stands.
import type { Translate } from './i18n.ts';
import { ApiError } from './screen.ts';

export const setupPending = (error: unknown): boolean => error instanceof ApiError && error.status === 503 && error.reason !== 'service_starting';

export function SetupPending({ t }: { readonly t: Translate }) {
  return (
    <div className="empty setup-pending" role="status">
      <p>{t('setup_pending')}</p>
      <a className="chip-button" href="/setup">{t('setup_pending_link')}</a>
    </div>
  );
}
