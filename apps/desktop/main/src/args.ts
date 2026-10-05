import { isAbsolute, join, resolve } from 'node:path';

export interface LaunchArgs {
  /** Profile name; each profile has its own identity, database and Chromium data. */
  profile: string;
  /** Root folder holding one sub-folder per profile. */
  dataRoot: string;
}

const PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * Parse `--profile=<name>` and `--data-root=<path>`. Data defaults to
 * `%LOCALAPPDATA%\OfficeMesh\<profile>` (plan section 15).
 */
export function parseLaunchArgs(argv: readonly string[], env: NodeJS.ProcessEnv): LaunchArgs {
  let profile = 'default';
  let dataRoot: string | undefined;
  for (const arg of argv) {
    const m = /^--(profile|data-root)=(.*)$/.exec(arg);
    if (!m) continue;
    if (m[1] === 'profile') {
      const value = m[2]!.toLowerCase();
      if (!PROFILE_PATTERN.test(value))
        throw new Error(`invalid --profile: use a-z, 0-9, _ or -, up to 32 characters`);
      profile = value;
    } else {
      dataRoot = isAbsolute(m[2]!) ? m[2]! : resolve(m[2]!);
    }
  }
  const localAppData = env['LOCALAPPDATA'] ?? join(env['USERPROFILE'] ?? '.', 'AppData', 'Local');
  return { profile, dataRoot: dataRoot ?? join(localAppData, 'OfficeMesh') };
}
