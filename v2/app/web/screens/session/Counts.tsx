import type { Translate } from '../../lib/i18n.ts';
import { quantity } from '../../lib/time.ts';

// The lines a file added and removed, said in the page's language.
export function Counts({ added, removed, t }: { readonly added: number; readonly removed: number; readonly t: Translate }) {
  return <><span className="add">+{quantity(added, t)}</span>{removed > 0 ? <>{' '}<span className="del">−{quantity(removed, t)}</span></> : null}</>;
}
