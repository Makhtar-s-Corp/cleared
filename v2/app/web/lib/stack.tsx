// A session kept mounted (docs/v2/ui-overhaul-plan.md, U4, lane 34): drawn
// in place while shown, hidden (display: none) while the person is
// elsewhere, never moved in the document, so its terminal, its editor, its
// browser frame and their scroll stay as they were.
//
// Several sessions kept at once draw the same element ids (#message,
// #tab-terminal...), which the session screen finds by id and its tabs
// name in aria-controls. While hidden, a view sets its ids aside
// (data-kept-id) and sets aside any id drawn meanwhile; shown again, it
// takes them back before the frame is painted. The shown session is then
// the only one with those ids, wherever it sits among the others.
import { useLayoutEffect, useRef, type ReactNode } from 'react';

const KEPT = 'keptId';

function stow(root: Element): void {
  for (const element of root.querySelectorAll<HTMLElement>('[id]')) {
    element.dataset[KEPT] = element.id;
    element.removeAttribute('id');
  }
}

function restore(root: Element): void {
  for (const element of root.querySelectorAll<HTMLElement>('[data-kept-id]')) {
    element.id = element.dataset[KEPT] ?? '';
    delete element.dataset[KEPT];
  }
}

export function KeptView({ id, shown, children }: { readonly id: string; readonly shown: boolean; readonly children: ReactNode }) {
  const root = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    if (shown) {
      restore(element);
      return;
    }
    stow(element);
    const drawn = new MutationObserver(() => stow(element));
    drawn.observe(element, { subtree: true, childList: true, attributes: true, attributeFilter: ['id'] });
    return () => drawn.disconnect();
  }, [shown]);
  return <div ref={root} data-session-view={id} style={{ display: shown ? 'contents' : 'none' }}>{children}</div>;
}
