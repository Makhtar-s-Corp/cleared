// The settings file applied before anything reads a setting: the first
// import of src/main.ts and app/main.ts (ES modules are evaluated in the
// order they are imported, so no module's top level runs before this).
// What the environment set at start is remembered: the setup module
// applies the file again when a step wrote it, and never replaces those.
import { applySettings, settingsPath } from './settings.ts';

export const FROM_ENVIRONMENT: ReadonlySet<string> = new Set(Object.entries(process.env).filter(([, value]) => value !== undefined && value !== '').map(([name]) => name));

// The file again, into this process's environment: after the app wrote the
// owner, or a step wrote a credential.
export function refreshSettings(env: NodeJS.ProcessEnv = process.env): void {
  const { refused } = applySettings(env, settingsPath(env), { fromEnvironment: FROM_ENVIRONMENT });
  for (const name of refused) console.error(`cleared-v2: the settings name a file for ${name} that is a link, belongs to another account, can be read by others or is empty: ${name} is not set from it`);
}

refreshSettings();
