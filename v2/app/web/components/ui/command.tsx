// shadcn/ui's Command (cmdk), copied in and restyled to the kit's palette
// (styles/app.css, .palette-*). No CommandDialog: cmdk's dialog is Radix's
// modal Dialog, whose scroll lock injects a <style> element, which the
// page's Content-Security-Policy (no inline style) refuses. The shell draws
// its own dialog around Command (shell/Palette.tsx).
import { MagnifyingGlass } from '@phosphor-icons/react';
import { Command as CommandPrimitive } from 'cmdk';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils.ts';

export function Command({ className, ...props }: ComponentProps<typeof CommandPrimitive>) {
  return <CommandPrimitive data-slot="command" className={cn('palette', className)} {...props} />;
}

export function CommandInput({ className, ...props }: ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div className="palette-input" data-slot="command-input-wrapper">
      <MagnifyingGlass size={16} aria-hidden="true" />
      <CommandPrimitive.Input data-slot="command-input" className={className} {...props} />
    </div>
  );
}

export function CommandList({ className, ...props }: ComponentProps<typeof CommandPrimitive.List>) {
  return <CommandPrimitive.List data-slot="command-list" className={cn('palette-list', className)} {...props} />;
}

export function CommandEmpty({ className, ...props }: ComponentProps<typeof CommandPrimitive.Empty>) {
  return <CommandPrimitive.Empty data-slot="command-empty" className={cn('palette-empty', className)} {...props} />;
}

export function CommandGroup(props: ComponentProps<typeof CommandPrimitive.Group>) {
  return <CommandPrimitive.Group data-slot="command-group" {...props} />;
}

export function CommandItem({ className, ...props }: ComponentProps<typeof CommandPrimitive.Item>) {
  return <CommandPrimitive.Item data-slot="command-item" className={cn('palette-item', className)} {...props} />;
}

export function CommandShortcut({ className, ...props }: ComponentProps<'span'>) {
  return <span data-slot="command-shortcut" className={cn('keys', className)} {...props} />;
}
