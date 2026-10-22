// What the shell gives a screen (shell/App.tsx): who is signed in, the
// translator, the clock, the address and the service's API. A screen
// component reads it with useScreen(); its model functions take the parts
// they need, so the tests run them without a browser.
import type { Translate } from './i18n.ts';

export type Me = {
  readonly user: { readonly id: string; readonly name: string };
  readonly csrf: string;
  readonly language: 'en' | 'fr';
  readonly project: string;
  readonly source: 'service' | 'fixtures';
};

export class ApiError extends Error {
  override name = 'ApiError';
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type ScreenContext = {
  readonly t: Translate;                                   // the screen's catalog, over the shell's
  readonly me: Me;
  readonly now: () => Date;
  readonly path: string;                                   // location.pathname, for a screen with a parameter
  // The service's API through the app: '/sessions' is /api/service/sessions.
  // A write carries the anti-forgery token. Rejects with ApiError.
  api<T>(path: string, init?: { readonly method?: 'GET' | 'POST'; readonly body?: unknown }): Promise<T>;
  inboxChanged(): void;                                    // asks the shell to recount the inbox
};
