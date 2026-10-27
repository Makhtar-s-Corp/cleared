// The Test secrets panel's rules (docs/v2/milestone-5-plan.md, section 12,
// C16), shared by the Services screen and the assistant's secrets step: a
// value's line in words, a refusal in words. No React here, so the node
// tests read it.
import type { TestValue } from '../../../../src/secrets/types.ts';
import { hasMark, type Translate } from '../../lib/i18n.ts';
import { dayOf } from '../setup/model.ts';

// "Set on 25 October by alex", or without the person when the service no longer knows them.
export function savedLine(value: TestValue, t: Translate): string {
  const date = dayOf(value.setAt, t);
  return value.setBy ? t('test_values_set_by', { date, by: value.setBy }) : t('test_values_set', { date });
}

// A refusal of the service as the catalogs say it; anything else as the general one.
export function testValueRefusal(t: Translate, body: unknown): string {
  const code = typeof (body as { error?: unknown } | null)?.error === 'string' ? (body as { error: string }).error : '';
  const said = /^[a-z_]+$/.test(code) ? t(`test_values_error_${code}`) : '';
  return said && !hasMark(said) ? said : t('test_values_error_other');
}

export type Answer<T> = { readonly status: number; readonly body: T };
export type TestValuesClient = {
  get<T>(path: string): Promise<Answer<T>>;
  post<T>(path: string, body?: unknown): Promise<Answer<T>>;
};

// The service's routes through the app, with the answer's body on a refusal
// too (the screens' api keeps only the status), as the assistant's setupApi.
export function testValuesClient(csrf: string, fetcher: typeof fetch = (url, init) => fetch(url, init)): TestValuesClient {
  const call = async <T>(path: string, init: RequestInit): Promise<Answer<T>> => {
    const response = await fetcher(`/api/service${path}`, { credentials: 'same-origin', ...init });
    return { status: response.status, body: await response.json().catch(() => ({})) as T };
  };
  return {
    get: (path) => call(path, { headers: { accept: 'application/json' } }),
    post: (path, body = {}) => call(path, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(body) }),
  };
}
