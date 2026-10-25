// An empty state (docs/v2/ui-overhaul-plan.md, 2.2.7): what is not there,
// in one sentence, what to do about it when that is not obvious, and the
// one action. A quiet row in a list; a block in an empty pane.
import type { Icon } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button.tsx';

export function Empty({ icon: Glyph, text, note, block = false, action, id }: {
  readonly icon: Icon; readonly text: string; readonly note?: string; readonly block?: boolean; readonly id?: string;
  readonly action?: { readonly label: string; readonly onClick: () => void } | undefined;
}) {
  return (
    <div className={block ? 'empty-state block' : 'empty-state'} id={id}>
      <Glyph size={block ? 24 : 18} aria-hidden="true" />
      <p className="empty-text">{text}{note ? <span className="empty-note">{note}</span> : null}</p>
      {action ? <Button variant="chip" className="chip-button" onClick={action.onClick}>{action.label}</Button> : null}
    </div>
  );
}
