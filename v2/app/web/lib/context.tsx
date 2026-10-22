// The screen's context in React: what the shell gives every screen.
import { createContext, useContext } from 'react';
import type { ScreenContext } from './screen.ts';

export const Screen = createContext<ScreenContext | null>(null);

export function useScreen(): ScreenContext {
  const context = useContext(Screen);
  if (!context) throw new Error('useScreen outside the shell');
  return context;
}
