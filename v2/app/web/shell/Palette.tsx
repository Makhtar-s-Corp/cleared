// The command palette (docs/v2/ui-overhaul-plan.md, 2.2.2, lane 35), on
// Cmd-K or Ctrl-K: a dialog over the app around shadcn's Command (cmdk),
// with the items palette.ts makes from the cache. The shell's own dialog,
// not cmdk's (components/ui/command.tsx says why): focus stays in it, Esc
// or a click outside closes it, and the focus goes back where it was.
import { ArrowRight, Broadcast, Circle, Keyboard, ListChecks, Moon, SidebarSimple, Sun, TerminalWindow, Tray, type Icon } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { defaultFilter } from 'cmdk';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command.tsx';
import type { Translate } from '@/lib/i18n.ts';
import { Keys } from './Kbd.tsx';
import { GROUP_LABEL, groupOrder, rank, type PaletteItem } from './palette.ts';

const GOTO_ICONS: Readonly<Record<string, Icon>> = { '/': Broadcast, '/inbox': Tray, '/sessions': TerminalWindow, '/lead': ListChecks };

function iconOf(item: PaletteItem, dark: boolean): Icon | null {
  switch (item.run.kind) {
    case 'navigate': return item.group === 'goto' ? GOTO_ICONS[item.run.href] ?? ArrowRight : item.group === 'sessions' ? TerminalWindow : null;
    case 'gesture': return ArrowRight;
    case 'theme': return dark ? Sun : Moon;
    case 'sheet': return Keyboard;
    case 'sidebar': return SidebarSimple;
  }
}

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

// The element the focus goes back to when a dialog closes.
export function useFocusBack(): void {
  const back = useRef<Element | null>(typeof document === 'undefined' ? null : document.activeElement);
  useEffect(() => () => {
    const element = back.current;
    if (element instanceof HTMLElement && element.isConnected) element.focus({ preventScroll: true });
  }, []);
}

export function Palette({ t, items, dark, onRun, onClose }: {
  readonly t: Translate; readonly items: readonly PaletteItem[]; readonly dark: boolean;
  readonly onRun: (item: PaletteItem) => void; readonly onClose: () => void;
}) {
  useFocusBack();
  const [search, setSearch] = useState('');
  const order = groupOrder(search);
  const grouped = useMemo(() => order.map((group) => ({ group, items: items.filter((item) => item.group === group) })).filter((g) => g.items.length > 0), [items, order]);
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    trapTab(event);
  };
  return (
    <div className="overlay" data-overlay="palette" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={t('palette_label')} id="palette" onKeyDown={keyDown}>
        <Command label={t('palette_label')} loop filter={(value, search, keywords) => rank(value, search, keywords ?? [], defaultFilter(value, search, keywords))}>
          <CommandInput placeholder={t('palette_placeholder')} autoFocus value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>{t('palette_empty')}</CommandEmpty>
            {grouped.map(({ group, items: rows }) => (
              <CommandGroup key={group} value={group} heading={t(GROUP_LABEL[group])} data-group={group}>
                {rows.map((item) => {
                  const Glyph = iconOf(item, dark);
                  return (
                    <CommandItem key={item.id} value={item.id} keywords={[item.label, item.detail ?? '', ...item.keywords]} data-item={item.id} onSelect={() => onRun(item)}>
                      {item.group === 'waiting' ? <span className="state-dot" data-state="waiting" aria-hidden="true" />
                        : Glyph ? <Glyph size={16} aria-hidden="true" /> : <Circle size={16} aria-hidden="true" />}
                      <span className="label">{item.label}</span>
                      {item.detail ? <span className="detail">{item.detail}</span> : null}
                      {item.shortcut ? <Keys keys={item.shortcut} /> : null}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </div>
    </div>
  );
}
