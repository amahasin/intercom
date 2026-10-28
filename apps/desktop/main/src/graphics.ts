import { execFile } from 'node:child_process';

/**
 * The names Windows gives this PC's display adapters ("NVIDIA GeForce RTX 3060", "Intel(R) UHD
 * Graphics"), for the Computer card on a colleague's page. Read once, from the system's own
 * inventory; nothing is installed and nothing leaves the PC but the name.
 */
export function graphicsAdapters(): Promise<string[]> {
  return new Promise((resolve, reject) =>
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(Get-CimInstance Win32_VideoController).Name | ConvertTo-Json -Compress',
      ],
      { timeout: 20_000, windowsHide: true },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          // One adapter is a string, several are an array, none is nothing.
          const parsed: unknown = stdout.trim() ? JSON.parse(stdout) : [];
          const list = Array.isArray(parsed) ? parsed : [parsed];
          resolve(list.filter((n): n is string => typeof n === 'string'));
        } catch (e) {
          reject(e as Error);
        }
      },
    ),
  );
}
