// What the shell's two dialogs (the palette, the shortcut sheet) share:
// Tab kept inside. The shell gives the focus back where it was on close
// (shell/App.tsx).
import type { KeyboardEvent } from 'react';

// Keeps Tab inside the dialog: its one field and its list are all it holds.
export function trapTab(event: KeyboardEvent<HTMLElement>): void {
  if (event.key !== 'Tab') return;
  const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>('input, button, [href], [tabindex]:not([tabindex="-1"])')];
  if (focusable.length === 0) return;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
