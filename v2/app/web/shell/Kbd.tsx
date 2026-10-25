// A shortcut's keys as the sidebar, the palette and the sheet draw them:
// one <kbd> per key, in the person's language, and in the sheet "then"
// between the two keys of a chord (keys.ts).
import { Fragment } from 'react';
import type { Translate } from '@/lib/i18n.ts';
import { keyLabel } from './keys.ts';

export const isMac = (): boolean => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function Keys({ keys, t, mac = isMac(), then = false, className = 'keys' }: { readonly keys: readonly string[]; readonly t: Translate; readonly mac?: boolean; readonly then?: boolean; readonly className?: string }) {
  return (
    <span className={className} aria-hidden="true">
      {keys.map((key, index) => (
        <Fragment key={index}>
          {index > 0 && then ? <span className="then">{t('keys_then')}</span> : null}
          {key.split('+').map((part) => <kbd key={part}>{keyLabel(part, mac, t)}</kbd>)}
        </Fragment>
      ))}
    </span>
  );
}
