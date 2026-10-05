/**
 * One headless core peer as a bare Node process (no Electron). Started by the sim with
 * `child_process.fork`; reports readiness over the IPC channel and stops on request.
 *
 *   node tools/sim/src/peer.ts --data-dir=<dir> --profile=<name> --name=<display name>
 */
import { Core, silentLogger } from '@officemesh/core';
import { InsecureTestKeyProtector } from '@officemesh/core/testing';
import type { PeerToSim, SimToPeer } from './messages.ts';

function arg(name: string): string {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  if (!found) throw new Error(`missing ${prefix}`);
  return found.slice(prefix.length);
}

const send = (message: PeerToSim) => process.send?.(message);

const core = await Core.start({
  dataDir: arg('data-dir'),
  profile: arg('profile'),
  appVersion: 'sim',
  keyProtector: new InsecureTestKeyProtector(),
  logger: silentLogger,
  defaultDisplayName: async () => arg('name'),
}).catch((err: unknown) => {
  send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});

send({ type: 'ready', pid: process.pid, identity: core.identityView() });

async function stop(): Promise<void> {
  await core.close();
  process.exit(0);
}

process.on('message', (message: SimToPeer) => {
  if (message.type === 'stop') void stop();
});
process.on('SIGTERM', () => void stop());
process.on('disconnect', () => void stop());
