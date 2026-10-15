import { arch, cpus, hostname, release, totalmem, version } from 'node:os';
import type { MachineInfo } from '@officemesh/protocol';

/**
 * This PC, in the plain facts a colleague's page shows: its name on the network, the system and
 * its version, the processor and the memory. Told to colleagues in `hello`; nothing here is
 * secret on an office network, and nothing that identifies the person (the user name is not).
 */
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
