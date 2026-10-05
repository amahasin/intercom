/**
 * One headless core peer as a bare Node process (no Electron), with the real network:
 * UDP beacons and mutual-TLS links. Started by the sim with `child_process.fork`.
 *
 *   node tools/sim/src/peer.ts --data-dir=<dir> --profile=<name> --name=<display name>
 *        [--discovery-port=<n>] [--lan=loopback] [--echo]
 */
import {
  Core,
  createTlsTransport,
  LOOPBACK_ONLY,
  silentLogger,
  UdpDiscoveryDriver,
} from '@officemesh/core';
import { InsecureTestKeyProtector } from '@officemesh/core/testing';
import type { PeerToSim, SimToPeer } from './messages.ts';

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}
function required(name: string): string {
  const v = arg(name);
  if (v === undefined) throw new Error(`missing --${name}=`);
  return v;
}

const send = (message: PeerToSim) => process.send?.(message);
const loopback = arg('lan') === 'loopback';
const discoveryPort = arg('discovery-port');

const core = await (async () => {
  const discovery = await UdpDiscoveryDriver.open({
    ...(discoveryPort && { port: Number(discoveryPort) }),
    logger: silentLogger,
    ...(loopback && { interfaces: LOOPBACK_ONLY }),
  });
  return Core.start({
    dataDir: required('data-dir'),
    filesDir: `${required('data-dir')}/files`,
    profile: required('profile'),
    appVersion: 'sim',
    keyProtector: new InsecureTestKeyProtector(),
    logger: silentLogger,
    defaultDisplayName: async () => required('name'),
    network: {
      discovery,
      transport: (identity) =>
        createTlsTransport(identity, {
          port: 0,
          ...(loopback && { host: '127.0.0.1' }),
          logger: silentLogger,
        }),
    },
  });
})().catch((err: unknown) => {
  send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});

// --echo: answer every message, so a person can try chat against a simulated colleague.
if (process.argv.includes('--echo')) {
  core.onEvent((name, payload) => {
    if (name !== 'messages.added') return;
    const { convId, messages } = payload as {
      convId: string;
      messages: Array<{ mine: boolean; text: string }>;
    };
    for (const m of messages) if (!m.mine) core.sendMessage(convId, `Echo: ${m.text}`);
  });
}

send({ type: 'ready', pid: process.pid, identity: core.identityView() });

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await core.close();
  process.exit(0);
}

function act(message: Extract<SimToPeer, { type: 'act' }>): unknown {
  switch (message.op) {
    case 'dm': {
      const conv = core.openDirect(message.userId);
      core.sendMessage(conv.convId, message.text);
      return conv.convId;
    }
    case 'group':
      return core.createGroup(message.members, message.title).convId;
    case 'post':
      core.sendMessage(message.convId, message.text);
      return true;
    case 'presence':
      return core.setPresence(message.state).manual;
    case 'stats':
      return {
        rssMb: Math.round(process.memoryUsage().rss / 1048576),
        online: core.people().filter((p) => p.online).length,
      };
  }
}

process.on('message', (message: SimToPeer) => {
  if (message.type === 'stop') void stop();
  else if (message.type === 'act') {
    try {
      send({ type: 'done', id: message.id, result: act(message) });
    } catch (err) {
      send({
        type: 'done',
        id: message.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
});
process.on('SIGTERM', () => void stop());
process.on('disconnect', () => void stop());
