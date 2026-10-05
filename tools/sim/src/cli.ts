/**
 * pnpm sim [--peers=N] [--data-root=DIR] [--keep]
 *
 * Starts N headless core peers as separate Node processes and keeps them running until
 * Ctrl+C. From M1 they discover each other and the desktop app over loopback.
 */
import { parseArgs } from 'node:util';
import { startProcessPeers } from './index.ts';

const { values } = parseArgs({
  options: {
    peers: { type: 'string', default: '3' },
    'data-root': { type: 'string' },
    keep: { type: 'boolean', default: false },
  },
});

const count = Number(values.peers);
if (!Number.isInteger(count) || count < 1 || count > 500) {
  console.error('--peers must be an integer from 1 to 500');
  process.exit(2);
}

const started = Date.now();
const sim = await startProcessPeers({
  count,
  ...(values['data-root'] !== undefined && { dataRoot: values['data-root'] }),
  keepData: values.keep,
});

console.log(
  `started ${sim.peers.length} peers in ${Date.now() - started} ms (data: ${sim.dataRoot})`,
);
console.table(
  sim.peers.map((p) => ({
    profile: p.profile,
    name: p.identity.displayName,
    userId: p.identity.userId,
    pid: p.pid,
  })),
);
console.log('Ctrl+C to stop.');

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await sim.stop();
  console.log('stopped');
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
