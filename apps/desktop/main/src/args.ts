import { isAbsolute, join, resolve } from 'node:path';

export type FirewallOverride = 'ok' | 'missing' | 'public';

export interface LaunchArgs {
  /** Profile name; each profile has its own identity, database and Chromium data. */
  profile: string;
  /** Root folder holding one sub-folder per profile. */
  dataRoot: string;
  /** UDP beacon port (default 47800). Tests use their own to stay off the real LAN. */
  discoveryPort: number | undefined;
  /** Preferred TCP link port (default 47801; 0 = any free port). */
  linkPort: number | undefined;
  /** Beacon on loopback only (tests and demos on one PC). */
  loopbackOnly: boolean;
  /** Test hook: skip the Windows Firewall query and report this result. */
  firewallOverride: FirewallOverride | undefined;
}

const PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function port(name: string, value: string, allowZero: boolean): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < (allowZero ? 0 : 1) || n > 65535)
    throw new Error(`invalid --${name}`);
  return n;
}

/**
 * Parse launch flags. Data defaults to `%LOCALAPPDATA%\OfficeMesh\<profile>` (plan section 15).
 *   --profile=<name> --data-root=<path>
 *   --discovery-port=<n> --link-port=<n> --lan=loopback --firewall-status=ok|missing|public
 */
export function parseLaunchArgs(argv: readonly string[], env: NodeJS.ProcessEnv): LaunchArgs {
  let profile = 'default';
  let dataRoot: string | undefined;
  let discoveryPort: number | undefined;
  let linkPort: number | undefined;
  let loopbackOnly = false;
  let firewallOverride: FirewallOverride | undefined;
  for (const arg of argv) {
    const m = /^--(profile|data-root|discovery-port|link-port|lan|firewall-status)=(.*)$/.exec(arg);
    if (!m) continue;
    const value = m[2]!;
    switch (m[1]) {
      case 'profile':
        if (!PROFILE_PATTERN.test(value.toLowerCase())) {
          throw new Error('invalid --profile: use a-z, 0-9, _ or -, up to 32 characters');
        }
        profile = value.toLowerCase();
        break;
      case 'data-root':
        dataRoot = isAbsolute(value) ? value : resolve(value);
        break;
      case 'discovery-port':
        discoveryPort = port('discovery-port', value, false);
        break;
      case 'link-port':
        linkPort = port('link-port', value, true);
        break;
      case 'lan':
        loopbackOnly = value === 'loopback';
        break;
      case 'firewall-status':
        if (value === 'ok' || value === 'missing' || value === 'public') firewallOverride = value;
        break;
    }
  }
  const localAppData = env['LOCALAPPDATA'] ?? join(env['USERPROFILE'] ?? '.', 'AppData', 'Local');
  return {
    profile,
    dataRoot: dataRoot ?? join(localAppData, 'OfficeMesh'),
    discoveryPort,
    linkPort,
    loopbackOnly,
    firewallOverride,
  };
}
