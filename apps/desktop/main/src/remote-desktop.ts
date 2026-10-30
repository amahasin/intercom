import { execFile, spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RemoteDesktopHost, WakeSender } from '@officemesh/core';

/**
 * "Remote Desktop Connection" on a colleague's page: Windows' own program, started at their address.
 *
 * To connect without asking, the sign-in is first put where that program looks for it: a
 * Credential Manager entry named `TERMSRV/<address>` (what the program itself writes when "Remember
 * me" is ticked). Windows keeps it sealed for this account. InterCom keeps its own copy only so it
 * can be put there again (the address may change); it is sealed with the same key as the identity,
 * and never shown.
 */
const SYSTEM32 = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32');

/** The Credential Manager target for an address: the name without its port. */
const targetOf = (address: string): string => `TERMSRV/${address.replace(/:\d+$/, '')}`;

/**
 * Writes one generic credential with the Windows API (`CredWriteW`). The user name and password
 * come in on standard input, never on a command line (which any program of this user can read, and
 * which `cmdkey` also cannot quote for every character a password may hold).
 */
const WRITE_CREDENTIAL = `
$ErrorActionPreference = 'Stop'
$j = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())) | ConvertFrom-Json
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
public class InterComCredential {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CRED { public uint Flags; public uint Type; public string TargetName; public string Comment; public long LastWritten; public uint BlobSize; public IntPtr Blob; public uint Persist; public uint Attrs; public IntPtr Attr; public string Alias; public string User; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredWriteW(ref CRED c, uint flags);
  public static void Write(string target, string user, string pass) {
    var blob = Encoding.Unicode.GetBytes(pass);
    var h = Marshal.AllocHGlobal(blob.Length);
    try {
      Marshal.Copy(blob, 0, h, blob.Length);
      var c = new CRED { Type = 1, TargetName = target, User = user, Blob = h, BlobSize = (uint)blob.Length, Persist = 2 };
      if (!CredWriteW(ref c, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(h); }
  }
}
"@
[InterComCredential]::Write($j.target, $j.user, $j.pass)
`;
const WRITE_CREDENTIAL_ENCODED = Buffer.from(WRITE_CREDENTIAL, 'utf16le').toString('base64');

/** Give Windows the sign-in for an address. A failure says only that it failed (an error could repeat the password). */
export function saveCredential(address: string, username: string, password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = () => reject(new Error('Windows would not take the saved sign-in.'));
    const child = execFile(
      join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        WRITE_CREDENTIAL_ENCODED,
      ],
      { timeout: 15_000, windowsHide: true },
      (err) => (err ? failed() : resolve()),
    );
    const body = JSON.stringify({ target: targetOf(address), user: username, pass: password });
    child.stdin?.end(Buffer.from(body, 'utf8').toString('base64'));
  });
}

export const windowsRemoteDesktop: RemoteDesktopHost = {
  async connect(address, login) {
    if (login) await saveCredential(address, login.username, login.password);
    // Its own window; InterCom does not wait for it.
    const child = spawn(join(SYSTEM32, 'mstsc.exe'), [`/v:${address}`], {
      detached: true,
      stdio: 'ignore',
    });
    child.once('error', () => {});
    child.unref();
  },
  async forget(address) {
    await new Promise<void>((resolve, reject) =>
      execFile(
        join(SYSTEM32, 'cmdkey.exe'),
        [`/delete:${targetOf(address)}`],
        { timeout: 10_000, windowsHide: true },
        (err) => (err ? reject(new Error('Windows kept the saved sign-in.')) : resolve()),
      ),
    );
  },
};

/** Tests: note each Wake on LAN datagram in a file instead of putting it on the network. */
export function fakeWakeSender(report: string): WakeSender {
  return async (packet, route) => {
    appendFileSync(
      report,
      `${JSON.stringify({ mac: packet.subarray(6, 12).toString('hex'), bytes: packet.length, from: route.from, to: route.to, port: route.port })}\n`,
    );
  };
}

/** Tests: note what would have been started in a file, and start nothing (never in an installed build). */
export function fakeRemoteDesktop(report: string): RemoteDesktopHost {
  return {
    async connect(address, login) {
      appendFileSync(report, `${JSON.stringify({ action: 'connect', address, login })}\n`);
    },
    async forget(address) {
      appendFileSync(report, `${JSON.stringify({ action: 'forget', address })}\n`);
    },
  };
}
