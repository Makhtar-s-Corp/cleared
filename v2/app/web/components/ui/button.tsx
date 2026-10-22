// shadcn/ui's Button, copied in and restyled to the kit: ink for the one
// gesture a screen waits for, an outlined surface for the others, the chip
// of the tower bar, a ghost for the header's icons, a link. Sizes stay with
// the screens' sheets (32, 36, 42 or 44 px, by place and width), which set
// them on the class each button keeps (btn, plain, chip-button, icon...),
// and so does the layout inside a button (a stacked commit id, a wrapping
// choice): the base sets nothing the sheets would have to undo.
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils.ts';

export const buttonVariants = cva(
  'border-0 cursor-pointer disabled:cursor-default',
  {
    variants: {
      variant: {
        ink: 'rounded-md bg-primary text-primary-foreground font-medium hover:opacity-88 disabled:opacity-50',
        outline: 'rounded-md bg-card shadow-control hover:bg-accent disabled:opacity-45',
        chip: 'rounded-full bg-transparent shadow-control text-xs hover:bg-accent',
        ghost: 'rounded-md bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
        link: 'bg-transparent p-0 text-link hover:underline',
      },
    },
    defaultVariants: { variant: 'outline' },
  },
);

export type ButtonProps = ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { readonly asChild?: boolean };

export function Button({ className, variant, asChild = false, type = 'button', ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  return <Comp {...(asChild ? {} : { type })} data-slot="button" className={cn(buttonVariants({ variant }), className)} {...props} />;
}
