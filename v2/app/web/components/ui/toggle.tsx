// shadcn/ui's Toggle (Radix): a button that says whether it is pressed
// (aria-pressed), as the lead's Goal and the inbox's frame switch do.
import * as TogglePrimitive from '@radix-ui/react-toggle';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils.ts';

export function Toggle({ className, ...props }: ComponentProps<typeof TogglePrimitive.Root>) {
  return <TogglePrimitive.Root data-slot="toggle" className={cn('cursor-pointer border-0', className)} {...props} />;
}
