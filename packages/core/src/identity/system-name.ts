import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';

// Full name of the signed-in Windows account: directory display name first (domain or
// local), then the local account's FullName. UTF-8 output so non-Latin names survive.
const SCRIPT = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
try {
  Add-Type -AssemblyName System.DirectoryServices.AccountManagement
  $n = [System.DirectoryServices.AccountManagement.UserPrincipal]::Current.DisplayName
  if ($n) { $n; exit 0 }
} catch {}
try {
  $u = [ADSI]("WinNT://$env:USERDOMAIN/$env:USERNAME,user")
  if ($u.FullName) { $u.FullName; exit 0 }
} catch {}
`;

function windowsFullName(timeoutMs: number): Promise<string | undefined> {
  if (process.platform !== 'win32') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
      { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => {
        const name = stdout?.trim().split(/\r?\n/)[0]?.trim();
        resolve(!error && name ? name.slice(0, 64) : undefined);
      },
    );
  });
}

/**
 * Default display name on first run: the Windows account's full name, then the login
 * name. Runs once per profile, so the PowerShell start-up cost is acceptable.
 */
export async function defaultDisplayName(timeoutMs = 5_000): Promise<string> {
  const full = await windowsFullName(timeoutMs);
  if (full) return full;
  try {
    const login = userInfo().username.trim();
    if (login) return login.slice(0, 64);
  } catch {
    // userInfo throws when the account has no username (rare service contexts).
  }
  return 'Colleague';
}
