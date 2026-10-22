// The header's notifications button and its menu (notify.ts says what it
// shows): hidden until the page knows what it can offer, then a bell, bold
// when this device is told.
import { BellSimple } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx';
import type { Translate } from '@/lib/i18n.ts';
import type { Me } from '@/lib/screen.ts';
import { notifyView, readBrowser, readNotify, toggleNotify, type NotifyRead, type NotifyView } from './notify.ts';

// The menu's content for a view: its state, the devices told, why there is
// no button, the button, and what the last gesture failed to do.
export function NotifyMenuBody({ view, t, error, busy, onToggle }: {
  readonly view: NotifyView; readonly t: Translate; readonly error?: string | undefined; readonly busy?: boolean; readonly onToggle?: (action: 'on' | 'off') => void;
}) {
  if (!view.show) return null;
  return (
    <>
      <p className="notify-state">{t(view.state)}</p>
      {view.devices === null ? null
        : <p className="faint">{view.devices === 0 ? t('notify_devices_none') : t(view.devices === 1 ? 'notify_devices_one' : 'notify_devices_other', { n: view.devices })}</p>}
      {view.note === null ? null : <p className="note">{t(view.note)}</p>}
      {view.action === null ? null : (
        <Button variant={view.action === 'on' ? 'ink' : 'outline'} className={view.action === 'on' ? 'primary' : 'plain'} id="notify-toggle" data-action={view.action}
          disabled={busy} onClick={() => onToggle?.(view.action as 'on' | 'off')}>
          {t(view.action === 'on' ? 'notify_turn_on' : 'notify_turn_off')}
        </Button>
      )}
      <p className="notify-error" id="notify-error" role="alert" hidden={!error}>{error}</p>
    </>
  );
}

const UNKNOWN = { supported: false, apple: false, installed: false, permission: 'default' } as const;

export function NotifyButton({ t, me }: { readonly t: Translate; readonly me: Me | null }) {
  const [read, setRead] = useState<NotifyRead>({ status: null, registration: null, subscription: null });
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!me) return;
    let live = true;
    void readNotify(null).then((next) => { if (live) setRead(next); });
    return () => { live = false; };
  }, [me]);

  const toggle = useCallback(async (action: 'on' | 'off') => {
    if (!me) return;
    const failed = await toggleNotify(read, action === 'on', me, t, () => setBusy(true));
    const next = await readNotify(read.registration);
    setRead(next);
    setBusy(false);
    setError(failed ? t(failed) : undefined);
    queueMicrotask(() => document.getElementById('notify-toggle')?.focus());
  }, [me, read, t]);

  // The browser is read only once the service has answered: before that, nothing shows.
  const view = read.status === null ? notifyView(null, UNKNOWN, false) : notifyView(read.status, readBrowser(), read.subscription !== null);
  return (
    <div className={view.show && view.on ? 'notify on' : 'notify'} id="notify" hidden={!view.show}>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="ghost" className="icon" id="notify-summary" aria-label={t(view.show && view.on ? 'notify_label_on' : 'notify_label')}>
            <BellSimple size={18} weight={view.show && view.on ? 'bold' : 'regular'} aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="notify-menu" id="notify-menu">
          <NotifyMenuBody view={view} t={t} error={error} busy={busy} onToggle={(action) => void toggle(action)} />
        </PopoverContent>
      </Popover>
    </div>
  );
}
