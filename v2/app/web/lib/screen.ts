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
  // The web terminal is offered (decision 32): the page came through the
  // app's loopback address. Absent from an app before lane 31: not offered.
  readonly terminal?: boolean;
};

export class ApiError extends Error {
  override name = 'ApiError';
  readonly status: number;
  readonly reason: string | undefined;                     // the answer's { error }, when it gave one
  readonly detail: string | undefined;                     // the answer's { reason }: why, when the error has several
  constructor(status: number, message: string, reason?: string, detail?: string) {
    super(message);
    this.status = status;
    this.reason = reason;
    this.detail = detail;
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
  // The page's one document (lane 34): `live` calls `run` when a resource
  // the screen read has a new value (lib/query.tsx, useLive), `navigate`
  // moves to another of the app's addresses without loading a document.
  // Absent outside the shell (a component's test): no redraw, and
  // navigate falls back to the browser.
  live?(run: () => void): () => void;
  navigate?(href: string, options?: { readonly replace?: boolean }): void;
};

