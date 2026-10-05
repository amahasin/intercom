/**
 * Can this PC host a large meeting's media relay? (Plan section 9, M6.) A relay-capable
 * PC is on wired gigabit Ethernet with 8 or more logical cores, and has the mediasoup
 * worker (x64 builds). A PC with the worker that misses the rest may still host a
 * meeting capped at 25 people when nobody better is present.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { RELAY_CAPABLE_SCORE } from '@officemesh/protocol';

export interface RelayCapability {
  /** 0: cannot host; below RELAY_CAPABLE_SCORE: capped hosting; at or above: capable. */
  score: number;
  capable: boolean;
  reason: string;
}

export interface WiredLink {
  /** Fastest connected wired adapter that has an IPv4 address, in bits per second (0: none). */
  wiredBps: number;
}

/** Ask Windows for the connected physical adapters (no elevation needed). */
export function detectWiredLink(): Promise<WiredLink> {
  if (process.platform !== 'win32') return Promise.resolve({ wiredBps: 0 });
  const script = `
    $ErrorActionPreference = 'SilentlyContinue'
    @(Get-NetAdapter -Physical | Where-Object Status -eq 'Up' | ForEach-Object {
      [pscustomobject]@{
        media = [string]$_.PhysicalMediaType
        speed = [double]$_.ReceiveLinkSpeed
        ip = @(Get-NetIPAddress -InterfaceIndex $_.ifIndex -AddressFamily IPv4).Count
      }
    }) | ConvertTo-Json -Compress`;
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 20_000, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => {
        if (err) return resolve({ wiredBps: 0 });
        try {
          const raw = JSON.parse(stdout.trim() || '[]') as unknown;
          const list = (Array.isArray(raw) ? raw : [raw]) as Array<{
            media: string;
            speed: number;
            ip: number;
          }>;
          const wired = list.filter((a) => a.media === '802.3' && a.ip > 0);
          resolve({ wiredBps: Math.max(0, ...wired.map((a) => a.speed)) });
        } catch {
          resolve({ wiredBps: 0 });
        }
      },
    );
  });
}

export function relayCapability(input: {
  workerBin: string | undefined;
  wiredBps: number;
  cores?: number;
  hosting: 'auto' | 'never';
}): RelayCapability {
  const cores = input.cores ?? availableParallelism();
  if (input.hosting === 'never')
    return { score: 0, capable: false, reason: 'Hosting is turned off in Settings.' };
  if (!input.workerBin || !existsSync(input.workerBin))
    return {
      score: 0,
      capable: false,
      reason: 'This build cannot host large meetings (no relay component for this processor).',
    };
  const gigabit = input.wiredBps >= 1e9;
  if (cores >= 8 && gigabit) {
    return {
      score: RELAY_CAPABLE_SCORE + cores * 10 + Math.min(10, Math.floor(input.wiredBps / 1e9)),
      capable: true,
      reason: `Wired ${Math.round(input.wiredBps / 1e6)} Mbps and ${cores} logical cores.`,
    };
  }
  const missing = [
    ...(gigabit ? [] : ['wired gigabit Ethernet']),
    ...(cores >= 8 ? [] : [`8 logical cores (it has ${cores})`]),
  ];
  return {
    score: Math.max(1, Math.min(RELAY_CAPABLE_SCORE - 1, cores)),
    capable: false,
    reason: `Can host meetings of up to 25 people; needs ${missing.join(' and ')} for more.`,
  };
}
