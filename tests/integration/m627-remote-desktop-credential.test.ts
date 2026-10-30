/**
 * M6.27: the sign-in saved for Remote Desktop Connection goes into Windows' Credential Manager under
 * `TERMSRV/<address>`, where that program looks for it. Whatever characters a password has must come
 * out exactly as they went in. This uses the real Windows API with a name that cannot exist
 * (`.invalid`) and removes it again.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// The host program's code, loaded by path: it belongs to the app's main process, which has its own
// build settings, so this project does not compile it, it only runs it.
interface HostCode {
  saveCredential(address: string, username: string, password: string): Promise<void>;
  windowsRemoteDesktop: { forget(address: string): Promise<void> };
}
const { saveCredential, windowsRemoteDesktop } = (await import(
  pathToFileURL(
    join(dirname(fileURLToPath(import.meta.url)), '../../apps/desktop/main/src/remote-desktop.ts'),
  ).href
)) as HostCode;

const ADDRESS = 'intercom-credential-test.invalid';

/** What Credential Manager holds for the target, read the way a program would (CredReadW). */
function read(): { user: string; password: string } | undefined {
  const script = `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class InterComRead {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CRED { public uint Flags; public uint Type; public string TargetName; public string Comment; public long LastWritten; public uint BlobSize; public IntPtr Blob; public uint Persist; public uint Attrs; public IntPtr Attr; public string Alias; public string User; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredReadW(string t, uint type, uint flags, out IntPtr p);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr p);
  public static string Read(string t) { IntPtr p; if (!CredReadW(t, 1, 0, out p)) return ""; var c = (CRED)Marshal.PtrToStructure(p, typeof(CRED)); var pw = Marshal.PtrToStringUni(c.Blob, (int)c.BlobSize/2); var u = c.User; CredFree(p); return Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(u)) + " " + Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(pw)); }
}
"@
[InterComRead]::Read('TERMSRV/${ADDRESS}')`;
  const out = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
  if (!out) return undefined;
  const [user, password] = out.split(' ').map((b) => Buffer.from(b, 'base64').toString('utf8')) as [
    string,
    string,
  ];
  return { user, password };
}

describe('M6.27 the saved Remote Desktop sign-in reaches Windows exactly', () => {
  it('keeps every character of a password, and the user name, and can be taken away again', async () => {
    try {
      for (const password of [
        'plain123',
        'with spaces in it',
        'quote"inside and back\\slash\\',
        'caret^amp&pipe|percent%1% -dash /pass:switch',
        'ünïcödé-пароль-密码',
      ]) {
        await saveCredential(`${ADDRESS}:3390`, 'WORKGROUP\\someone', password);
        // The port is not part of the name Windows looks for.
        expect(read()).toEqual({ user: 'WORKGROUP\\someone', password });
      }
      await windowsRemoteDesktop.forget(`${ADDRESS}:3390`);
      expect(read()).toBeUndefined();
    } finally {
      await windowsRemoteDesktop.forget(ADDRESS).catch(() => {});
    }
  }, 60_000);

  it('does not repeat the password when Windows refuses', async () => {
    // A password Windows rejects (past the size a credential may hold): the message must not carry it.
    const secret = 'S3cret-that-must-not-leak';
    const error = await saveCredential(ADDRESS, 'user', `${'p'.repeat(2_000)}${secret}`).catch(
      (e: Error) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(secret);
  }, 30_000);
});
