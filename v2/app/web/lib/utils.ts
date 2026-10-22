// shadcn/ui's class helper: clsx for the conditions, tailwind-merge so a
// later utility replaces an earlier one of the same property.
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
