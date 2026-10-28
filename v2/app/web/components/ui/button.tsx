// shadcn/ui's Button, copied in and restyled to the kit (Workbench, lane
// j6-ui-pro): indigo for the one gesture a screen waits for, a white
// surface with a 1px line and a 6 px radius for the others, the chip
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
        ink: 'rounded-md bg-primary text-primary-foreground font-[var(--weight-strong)] hover:bg-[var(--accent-hover)] active:bg-[var(--accent-press)] disabled:bg-[var(--surface-muted)] disabled:text-[var(--text-faint)]',
        outline: 'rounded-md bg-[var(--surface)] [box-shadow:var(--e-control)] hover:bg-accent active:bg-[var(--selected)] disabled:text-[var(--text-faint)] disabled:[box-shadow:var(--e-outline)]',
        chip: 'rounded-md bg-[var(--surface)] [box-shadow:var(--e-control)] text-xs hover:bg-accent active:bg-[var(--selected)]',
        ghost: 'rounded-md bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground active:bg-[var(--selected)]',
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
