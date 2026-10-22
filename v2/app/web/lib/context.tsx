// The screen's context in React: what the shell gives every screen.
import { createContext, useCallback, useContext } from 'react';
import type { ScreenContext } from './screen.ts';

export const Screen = createContext<ScreenContext | null>(null);

export function useScreen(): ScreenContext {
  const context = useContext(Screen);
  if (!context) throw new Error('useScreen outside the shell');
  return context;
}

// Moves to an address of the app: in the page under the shell's router
// (lane 34), else as a document load (a component's test, the sign-in page).
export function useGo(): (href: string) => void {
  const context = useContext(Screen);
  return useCallback((href: string) => {
    if (context?.navigate) context.navigate(href);
    else location.assign(href);
  }, [context]);
}
