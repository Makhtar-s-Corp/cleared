// The profiles' routes (issue #452, the shapes in profiles/types.ts),
// served by the flow module: the Services screen's panel and anyone with
// the app's proof reads both histories, writes a new version of either, or
// restores an old one as the next version. A person the service knows, not
// the flow's own identities. A refusal is a code the screen says in words
// (profiles_error_<code>), never the value refused.
import type { DatabaseSync } from 'node:sqlite';
import type { Registry, Route, RouteContext } from '../modules/registry.ts';
import type { UserId } from '../session/contract.ts';
import { answer, HttpError, humanUser, readBody } from '../terminal/routes.ts';
import { ProfileError, profileVersions, SEED_AUTHOR, type ProfileVersions, type Versioned, type VersionStore } from './store.ts';
import { PROFILES_PATH, type ProfilesView, type VersionView } from './types.ts';

const MAX_BODY = 32 * 1024;

export type ProfileRouteDeps = {
  readonly db: () => DatabaseSync | undefined;          // undefined: no ledger yet
  readonly proof: () => string;
};

// A person's name by their id; undefined for one the service does not know.
export type NameOf = (id: UserId) => Promise<string | undefined>;
const namesOf = (registry: Registry): NameOf => async (id) => (await registry.users.get(id))?.name;

// A version as a person reads it: who wrote it by name; the service's first, or a person it no longer knows, by nobody.
export async function versionView<T>(version: Versioned<T>, nameOf: NameOf): Promise<VersionView<T>> {
  const name = version.createdBy === SEED_AUTHOR ? undefined : await nameOf(version.createdBy);
  return { version: version.version, body: version.body, createdAt: version.createdAt, createdBy: name ?? null, restoredFrom: version.restoredFrom };
}

async function historyOf<T>(store: VersionStore<T>, nameOf: NameOf) {
  return { current: store.current().version, versions: await Promise.all(store.list().map((version) => versionView(version, nameOf))) };
}

export async function profilesView(versions: ProfileVersions, nameOf: NameOf): Promise<ProfilesView> {
  return { profile: await historyOf(versions.profile, nameOf), environment: await historyOf(versions.environment, nameOf) };
}

export function profileRoutes(deps: ProfileRouteDeps): Route[] {
  const handled = (run: (context: RouteContext, user: UserId, db: DatabaseSync) => Promise<unknown>): Route['handle'] => async (context) => {
    try {
      const user = await humanUser(context, deps.proof());
      const db = deps.db();
      if (!db) throw new HttpError(503, 'the flow module has no ledger');
      answer(context, 200, await run(context, user, db));
    } catch (error) {
      if (error instanceof ProfileError) return answer(context, 400, { error: error.code });
      if (!(error instanceof HttpError)) throw error;
      if (context.response.headersSent) context.response.end();
      else answer(context, error.status, { error: error.status === 400 ? 'body' : error.message });
    }
  };
  const write = (object: 'profile' | 'environment', restore: boolean) => handled(async (context, user, db) => {
    const store: VersionStore<unknown> = profileVersions(db)[object];
    const body = await readBody(context.request, MAX_BODY);
    if (!restore) return versionView(store.save(body, user), namesOf(context.registry));
    if (Object.keys(body).join() !== 'version' || typeof body.version !== 'number') throw new ProfileError('version', 'a restore names { version }');
    return versionView(store.restore(body.version, user), namesOf(context.registry));
  });
  return [
    {
      method: 'GET', path: PROFILES_PATH,
      handle: handled(async (context, _user, db) => profilesView(profileVersions(db), namesOf(context.registry))),
    },
    { method: 'POST', path: `${PROFILES_PATH}/agent`, handle: write('profile', false) },
    { method: 'POST', path: `${PROFILES_PATH}/agent/restore`, handle: write('profile', true) },
    { method: 'POST', path: `${PROFILES_PATH}/environment`, handle: write('environment', false) },
    { method: 'POST', path: `${PROFILES_PATH}/environment/restore`, handle: write('environment', true) },
  ];
}
