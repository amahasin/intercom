import { statSync } from 'node:fs';
import { arch, cpus, networkInterfaces, release, totalmem, uptime, version } from 'node:os';
import { join } from 'node:path';
import type { Diagnostics } from '@officemesh/protocol/ipc';
import type { Core } from './core.ts';
import { DATABASE_FILE_NAME } from './core.ts';

/** Everything the Diagnostics page shows (M6). No message content, ever. */
export function collectDiagnostics(core: Core, log: string[]): Diagnostics {
  const network = core.network;
  const count = (sql: string) => (core.store.db.prepare(sql).get() as { n: number }).n;
  let databaseBytes = 0;
  try {
    const dir = core.appInfo().dataDir;
    databaseBytes = statSync(join(dir, DATABASE_FILE_NAME)).size;
    try {
      databaseBytes += statSync(join(dir, `${DATABASE_FILE_NAME}-wal`)).size;
    } catch {
      // No write-ahead log at the moment.
    }
  } catch {
    // The database path is unreadable; report 0.
  }
  const interfaces: Diagnostics['interfaces'] = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family === 'IPv4' && !i.internal)
        interfaces.push({ name, address: i.address, netmask: i.netmask });
    }
  }
  const linked = network?.links.readyPeers() ?? [];
  const mem = process.memoryUsage();
  return {
    generatedAt: core.clock.now(),
    app: core.appInfo(),
    system: {
      os: `${version()} ${release()}`,
      arch: arch(),
      cpus: cpus().length,
      memoryMb: Math.round(totalmem() / 1024 / 1024),
      uptimeS: Math.round(uptime()),
    },
    network: core.networkStatus(),
    interfaces,
    peers: {
      known: network?.directory.all().length ?? 0,
      online: network?.directory.onlineCount() ?? 0,
      remote: network?.remotePeersStatus().remoteOnline ?? 0,
      linked: linked.length,
    },
    links: linked.map((userId) => ({
      userId,
      name: network?.directory.get(userId)?.profile?.displayName ?? '',
      app: network?.links.peerApp(userId) ?? '',
      remote: network?.isRemote(userId) ?? false,
    })),
    manualPeers: network?.remotePeersStatus().manual ?? [],
    envelopes: network?.envelopes.stats() ?? { carrying: 0, carryingBytes: 0, outgoing: 0 },
    relay: core.relayStatus(),
    store: {
      databaseBytes,
      events: count('SELECT COUNT(*) AS n FROM events'),
      messages: count('SELECT COUNT(*) AS n FROM messages'),
      conversations: count('SELECT COUNT(*) AS n FROM conversations'),
    },
    memory: {
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapMb: Math.round(mem.heapUsed / 1024 / 1024),
    },
    restart: { moment: core.updateReadiness(), busyWith: core.busyWith() ?? null },
    log,
  };
}
