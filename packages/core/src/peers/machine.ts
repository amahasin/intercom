import { arch, cpus, hostname, networkInterfaces, release, totalmem, version } from 'node:os';
import type { MachineInfo } from '@officemesh/protocol';

/**
 * This PC, in the plain facts a colleague's page shows: its name on the network, the system and
 * its version, the processor and the memory. Told to colleagues in `hello`; nothing here is
 * secret on an office network, and nothing that identifies the person (the user name is not).
 */
/** This PC's IPv4 addresses on its networks (not loopback, not link-local), the way colleagues reach it. */
export function localAddresses(): string[] {
  const found: string[] = [];
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? [])
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))
        found.push(a.address);
  return [...new Set(found)].slice(0, 16);
}

/** Display adapters that are no graphics card: a remote session, a virtual display, a fallback driver. */
const NOT_A_CARD =
  /basic (display|render)|remote|virtual|mirror|meta |parsec|citrix|indirect|idd|vnc/i;

/**
 * The graphics card(s) of a PC, from the names Windows gives its display adapters: the real ones
 * (a laptop has an integrated one and a discrete one), once each, in a short line. Nothing when
 * there is no name to show.
 */
export function describeGraphics(names: readonly string[]): string | undefined {
  const clean = [...new Set(names.map((n) => n.replace(/\s+/g, ' ').trim()).filter(Boolean))];
  const real = clean.filter((n) => !NOT_A_CARD.test(n));
  const shown = (real.length > 0 ? real : clean).slice(0, 2).join(' + ');
  return shown ? shown.slice(0, 120) : undefined;
}

export function describeThisMachine(): MachineInfo {
  const processors = cpus();
  const model = processors[0]?.model.replace(/\s+/g, ' ').trim();
  return {
    host: hostname().slice(0, 64) || 'unknown',
    os: `${version()} ${release()}`.trim().slice(0, 80),
    arch: arch().slice(0, 16),
    ...(model && { cpu: model.slice(0, 80) }),
    ...(processors.length > 0 && { cores: processors.length }),
    memoryMb: Math.max(1, Math.round(totalmem() / 1_048_576)),
  };
}
