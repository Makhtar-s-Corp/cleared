// shadcn/ui's Popover (Radix), restyled to the kit's menu card. Not modal:
// a modal popover locks the page's scroll with an injected <style>, which the
// page's Content-Security-Policy (no inline style) refuses.
import * as PopoverPrimitive from '@radix-ui/react-popover';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils.ts';

export function Popover(props: ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" modal={false} {...props} />;
}

export function PopoverTrigger(props: ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

export function PopoverContent({ className, align = 'end', sideOffset = 8, collisionPadding = 16, ...props }: ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content data-slot="popover-content" align={align} sideOffset={sideOffset} collisionPadding={collisionPadding}
        className={cn('menu outline-none', className)} {...props} />
    </PopoverPrimitive.Portal>
  );
}
