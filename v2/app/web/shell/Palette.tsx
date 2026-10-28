// The command palette (docs/v2/ui-overhaul-plan.md, 2.2.2, lane 35), on
// Cmd-K or Ctrl-K: a dialog over the app around shadcn's Command (cmdk),
// with the items palette.ts makes from the cache. The shell's own dialog,
// not cmdk's (components/ui/command.tsx says why): focus stays in it, Esc
// or a click outside closes it, and the focus goes back where it was.
import { ArrowRight, Broadcast, Circle, Keyboard, ListChecks, SidebarSimple, TerminalWindow, Tray, X, type Icon } from '@phosphor-icons/react';
import { useMemo, useState, type KeyboardEvent } from 'react';
import { defaultFilter } from 'cmdk';
import { Button } from '@/components/ui/button.tsx';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command.tsx';
import type { Translate } from '@/lib/i18n.ts';
import { trapTab } from './dialog.ts';
import { Keys } from './Kbd.tsx';
import { GROUP_LABEL, groupOrder, keywordsOf, rank, shownItems, type PaletteGroup, type PaletteItem } from './palette.ts';

const GOTO_ICONS: Readonly<Record<string, Icon>> = { '/': Broadcast, '/inbox': Tray, '/sessions': TerminalWindow, '/lead': ListChecks };

function iconOf(item: PaletteItem): Icon | null {
  switch (item.run.kind) {
    case 'navigate': return item.group === 'goto' ? GOTO_ICONS[item.run.href] ?? ArrowRight : item.group === 'sessions' ? TerminalWindow : null;
    case 'gesture': return ArrowRight;
    case 'sheet': return Keyboard;
    case 'sidebar': return SidebarSimple;
  }
}

export default function Palette({ t, items, onRun, onClose }: {
  readonly t: Translate; readonly items: readonly PaletteItem[];
  readonly onRun: (item: PaletteItem) => void; readonly onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const grouped = useMemo(() => {
    const shown = shownItems(items, search);
    const best: Partial<Record<PaletteGroup, number>> = {};
    if (search.trim()) {
      for (const item of shown) best[item.group] = Math.max(best[item.group] ?? 0, rank(item.id, search, keywordsOf(item), defaultFilter(item.id, search, keywordsOf(item))));
    }
    return groupOrder(search, best).map((group) => ({ group, items: shown.filter((item) => item.group === group) })).filter((g) => g.items.length > 0);
  }, [items, search]);
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    trapTab(event);
  };
  return (
    <div className="overlay" data-overlay="palette" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={t('palette_label')} id="palette" onKeyDown={keyDown}>
        <Command label={t('palette_label')} loop filter={(value, search, keywords) => rank(value, search, keywords ?? [], defaultFilter(value, search, keywords))}>
          <CommandInput placeholder={t('palette_placeholder')} autoFocus value={search} onValueChange={setSearch}>
            {/* A phone has no Esc: the palette closes from here too. */}
            <Button variant="ghost" className="icon" id="palette-close" aria-label={t('keys_close')} onClick={onClose}><X size={16} aria-hidden="true" /></Button>
          </CommandInput>
          <CommandList label={t('palette_results')}>
            <CommandEmpty>{t('palette_empty')}</CommandEmpty>
            {grouped.map(({ group, items: rows }) => (
              <CommandGroup key={group} value={group} heading={t(GROUP_LABEL[group])} data-group={group}>
                {rows.map((item) => {
                  const Glyph = iconOf(item);
                  return (
                    <CommandItem key={item.id} value={item.id} keywords={keywordsOf(item)} data-item={item.id} onSelect={() => onRun(item)}>
                      {item.group === 'waiting' ? <span className="state-dot" data-state="waiting" aria-hidden="true" />
                        : Glyph ? <Glyph size={16} aria-hidden="true" /> : <Circle size={16} aria-hidden="true" />}
                      <span className="palette-label">{item.label}</span>
                      {item.detail ? <span className="palette-detail">{item.detail}</span> : null}
                      {item.shortcut ? <Keys keys={item.shortcut} t={t} /> : null}
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
