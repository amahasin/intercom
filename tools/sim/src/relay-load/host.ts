/**
 * A relay host for the load test: a full core as a bare Node process, on loopback, with
 * the relay forced capable. The controller drives it over IPC.
 *
 *   node host.ts --data-dir=<dir> --profile=<name> --name=<name> --discovery-port=<n>
 *                --score=<relay score> --workers=<n>
 */
import { mkdirSync } from 'node:fs';
import {
  Core,
  createTlsTransport,
  LOOPBACK_ONLY,
  silentLogger,
  UdpDiscoveryDriver,
} from '@officemesh/core';
import { InsecureTestKeyProtector } from '@officemesh/core/testing';

function arg(name: string): string {
  const v = process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (v === undefined) throw new Error(`missing --${name}=`);
  return v;
}

const dataDir = arg('data-dir');
mkdirSync(dataDir, { recursive: true });
const discovery = await UdpDiscoveryDriver.open({
  port: Number(arg('discovery-port')),
  logger: silentLogger,
  interfaces: LOOPBACK_ONLY,
});
const core = await Core.start({
  dataDir,
  filesDir: `${dataDir}/files`,
  profile: arg('profile'),
  appVersion: 'sim',
  keyProtector: new InsecureTestKeyProtector(),
  logger: {
    ...silentLogger,
    warn: (m, d) => console.log(`[${arg('profile')}] WARN ${m} ${JSON.stringify(d ?? {})}`),
    info: (m, d) =>
      /relay|hand-over|meeting/.test(m) &&
      console.log(`[${arg('profile')}] ${m} ${JSON.stringify(d ?? {})}`),
  },
  defaultDisplayName: async () => arg('name'),
  relay: {
    score: Number(arg('score')),
    maxWorkers: Number(arg('workers')),
    listenIps: ['127.0.0.1'],
    allowPlain: true,
  },
  network: {
    discovery,
    transport: (identity) =>
      createTlsTransport(identity, { port: 0, host: '127.0.0.1', logger: silentLogger }),
  },
});

type Command =
  | { id: number; op: 'people' }
  | { id: number; op: 'group'; members: string[] }
  | { id: number; op: 'hasGroup'; convId: string }
  | { id: number; op: 'meetNow'; convId: string }
  | { id: number; op: 'card'; convId: string }
  | { id: number; op: 'join'; convId: string; target: { author: string; seq: number } }
  | { id: number; op: 'call' }
  | { id: number; op: 'relay' }
  | { id: number; op: 'stop' };

const reply = (id: number, data: unknown, error?: string) =>
  process.send?.({ type: 'reply', id, data, ...(error && { error }) });

process.on('message', (cmd: Command) => {
  void (async () => {
    try {
      switch (cmd.op) {
        case 'people':
          return reply(cmd.id, core.people().filter((p) => p.online).length);
        case 'group':
          return reply(cmd.id, core.createGroup(cmd.members, 'Whole office').convId);
        case 'hasGroup':
          return reply(
            cmd.id,
            core.conversationList().some((c) => c.convId === cmd.convId && c.active),
          );
        case 'meetNow':
          return reply(cmd.id, (await core.meetNow(cmd.convId, 'video')).callId);
        case 'card': {
          const card = core.listMessages(cmd.convId).find((m) => m.kindDetail === 'call');
          return reply(cmd.id, card ? { author: card.author, seq: card.seq } : null);
        }
        case 'join':
          return reply(cmd.id, (await core.joinCall(cmd.convId, cmd.target)).callId);
        case 'call': {
          const call = core.currentCall();
          return reply(
            cmd.id,
            call && {
              relay: call.relay ?? null,
              participants: call.participants.length,
            },
          );
        }
        case 'relay': {
          const host = core.calls?.relayHost;
          const cpu = process.cpuUsage();
          return reply(cmd.id, {
            hosting: host !== undefined,
            stats: host?.stats() ?? null,
            workerPids: host?.workerPids() ?? [],
            procCpuMs: (cpu.user + cpu.system) / 1000,
            rssMb: Math.round(process.memoryUsage().rss / 1048576),
          });
        }
        case 'stop':
          await core.close();
          reply(cmd.id, true);
          process.exit(0);
      }
    } catch (err) {
      reply(cmd.id, null, err instanceof Error ? err.message : String(err));
    }
  })();
});

process.send?.({ type: 'ready', userId: core.userId, pid: process.pid });
process.on('disconnect', () => process.exit(0));
