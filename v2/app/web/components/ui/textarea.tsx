// shadcn/ui's Textarea, restyled to the kit, as the Input.
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils.ts';

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea data-slot="textarea" className={cn('min-w-0 border-0 placeholder:text-placeholder', className)} {...props} />;
}
