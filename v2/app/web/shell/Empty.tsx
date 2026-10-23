// An empty state (docs/v2/ui-overhaul-plan.md, 2.2.7): what is not there,
// in one sentence, and the one thing to do about it.
import type { Icon } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button.tsx';

export function Empty({ icon: Glyph, text, action, id }: {
  readonly icon: Icon; readonly text: string; readonly id?: string;
  readonly action?: { readonly label: string; readonly onClick: () => void } | undefined;
}) {
  return (
    <div className="empty-state" id={id}>
      <Glyph size={18} aria-hidden="true" />
      <p className="empty-text">{text}</p>
      {action ? <Button variant="chip" className="chip-button" onClick={action.onClick}>{action.label}</Button> : null}
    </div>
  );
}
