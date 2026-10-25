// Close on the ticket's page (issue #249): the owner closes a ticket that
// should never ship, and says why. The reason is mandatory; the ticket's
// sessions stop, nothing of it waits in the inbox, nothing is merged.
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import type { Translate } from '@/lib/i18n.ts';
import { CLOSE_REASON_MAX, closeFailureKey, closeReason, closeTicket } from '@/lib/close.ts';
import { ApiError, type ScreenContext } from '@/lib/screen.ts';
import { clock } from '@/lib/time.ts';

export function CloseTicket({ ticket, api, now, t, onClosed }: {
  readonly ticket: string; readonly api: ScreenContext['api']; readonly now: () => Date; readonly t: Translate; readonly onClosed?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [closedAt, setClosedAt] = useState<string | null>(null);
  // Each gesture redraws the buttons, so the focus goes on: Close to the
  // reason, Keep back to Close, the outcome once closed (read out there),
  // a failure back to Close the ticket.
  const focusTo = useRef<string | null>(null);
  useEffect(() => {
    if (focusTo.current === null) return;
    document.getElementById(focusTo.current)?.focus();
    focusTo.current = null;
  });
  if (closedAt !== null) return <p className="d-done" id="close-done" role="status" tabIndex={-1}>{t('closed_done', { time: clock(closedAt) })}</p>;
  if (!open) return <Button className="btn" id="close-open" onClick={() => { focusTo.current = 'close-message'; setOpen(true); }}>{t('close')}</Button>;
  const send = async () => {
    const checked = closeReason(text);
    if ('error' in checked) { setNote(t(checked.error, { n: CLOSE_REASON_MAX })); return; }
    setBusy(true);
    try {
      const closed = await closeTicket(api, ticket, checked.reason, now());
      focusTo.current = 'close-done';
      setClosedAt(closed.at);
      setNote('');
      onClosed?.();
    } catch (error) {
      focusTo.current = 'close-send';
      setNote(t(closeFailureKey(error instanceof ApiError ? error.status : 0)));
    }
    setBusy(false);
  };
  return (
    <div className="close-ticket" id="close-form">
      <p className="faint small">{t('close_rule')}</p>
      <label className="change-field" htmlFor="close-message"><span className="sr-only">{t('close_field')}</span>
        <Textarea id="close-message" maxLength={CLOSE_REASON_MAX} rows={2} autoComplete="off" placeholder={t('close_field')} disabled={busy} value={text} onChange={(event) => setText(event.target.value)} />
      </label>
      <div className="close-buttons">
        <Button className="btn" id="close-keep" disabled={busy} onClick={() => { focusTo.current = 'close-open'; setOpen(false); setText(''); setNote(''); }}>{t('close_keep')}</Button>
        <Button variant="ink" className="btn primary" id="close-send" disabled={busy} onClick={() => void send()}>{t('close_send')}</Button>
      </div>
      <p className="composer-note" id="close-note" role="status">{note}</p>
    </div>
  );
}
