import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

export interface FirewallFindings {
  firewall: 'ok' | 'missing' | 'unknown';
  /** A connected network is set to Public. */
  publicNetwork: boolean;
}

function powershell(command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;

/**
 * Check, as a standard user, that the inbound InterCom rules exist for this program
 * (one UDP, one TCP) and whether any connected network is Public.
 */
export async function checkFirewall(program = process.execPath): Promise<FirewallFindings> {
  const script = `
    $ErrorActionPreference = 'SilentlyContinue'
    $rules = @(Get-NetFirewallApplicationFilter -Program ${quote(program)} | Get-NetFirewallRule |
      Where-Object { $_.Group -eq 'InterCom' -and $_.Enabled -eq 'True' -and $_.Action -eq 'Allow' -and $_.Direction -eq 'Inbound' })
    # The rules must cover the network this PC is on now, whatever Windows calls it
    # (Private, Domain or Public): rules from an older install may name only some profiles.
    $cats = @(Get-NetConnectionProfile | ForEach-Object { if ($_.NetworkCategory -eq 'DomainAuthenticated') { 'Domain' } else { [string]$_.NetworkCategory } } | Sort-Object -Unique)
    $covering = @($rules | Where-Object {
      $p = [string]$_.Profile
      $all = $p -match 'Any'
      foreach ($c in $cats) { if (-not $all -and $p -notmatch $c) { return $false } }
      return $true
    })
    $protocols = @($covering | Get-NetFirewallPortFilter | Select-Object -ExpandProperty Protocol)
    $ok = ($protocols -contains 'UDP') -and ($protocols -contains 'TCP')
    $public = @(Get-NetConnectionProfile | Where-Object { $_.NetworkCategory -eq 'Public' }).Count -gt 0
    @{ ok = $ok; public = $public } | ConvertTo-Json -Compress`;
  try {
    const out = JSON.parse((await powershell(script, 20_000)).trim()) as {
      ok: boolean;
      public: boolean;
    };
    return { firewall: out.ok ? 'ok' : 'missing', publicNetwork: out.public };
  } catch {
    return { firewall: 'unknown', publicNetwork: false };
  }
}

function firewallScript(): string {
  const packaged = join(process.resourcesPath, 'firewall.ps1');
  return app.isPackaged || existsSync(packaged)
    ? packaged
    : join(__dirname, '..', '..', 'resources', 'firewall.ps1');
}

/**
 * Add the rules for this program through an elevated PowerShell (one UAC prompt).
 * Rejects if the user declines or the script fails.
 */
export async function fixFirewall(program = process.execPath, relayWorker?: string): Promise<void> {
  const relay = relayWorker && existsSync(relayWorker) ? ` -RelayWorker "${relayWorker}"` : '';
  const args = `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${firewallScript()}" -Action add -Program "${program}"${relay}`;
  const command = `
    $p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList ${quote(args)}
    exit $p.ExitCode`;
  await powershell(command, 120_000);
}
