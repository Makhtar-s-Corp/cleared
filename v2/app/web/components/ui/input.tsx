// shadcn/ui's Input, restyled to the kit: a surface with the control's
// outline, the link colour as its focus ring. Heights stay with the sheets.
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils.ts';

export function Input({ className, type, ...props }: ComponentProps<'input'>) {
  return <input type={type} data-slot="input" className={cn('min-w-0 border-0 placeholder:text-placeholder disabled:cursor-default', className)} {...props} />;
}
