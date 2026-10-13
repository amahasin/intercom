/**
 * pnpm sim [--peers=N] [--lite=N] [--echo] [--lan=loopback|all] [--discovery-port=P]
 *          [--data-root=DIR] [--keep]
 *
 * --peers  full headless cores, one Node process each, that discover the app and chat
 * --lite   lightweight colleagues in this process: beacons and profiles only (scale tests)
 * --echo   full peers answer every message (try chat without a second PC)
 * --lan=loopback   stay on this PC (the default; pair with the app's --lan=loopback)
 * --lan=all        beacon on the real network: every InterCom there hears the simulated
 *                  colleagues and remembers them, so use it only on purpose
 * --exit-on-stdin-close   for test harnesses
 */
import { parseArgs } from 'node:util';
import { startLitePeers, startProcessPeers, type LiteSim, type ProcessSim } from './index.ts';

const { values } = parseArgs({
  options: {
    peers: { type: 'string', default: '3' },
    lite: { type: 'string', default: '0' },
    echo: { type: 'boolean', default: false },
    lan: { type: 'string', default: 'loopback' },
    'discovery-port': { type: 'string' },
    'data-root': { type: 'string' },
    keep: { type: 'boolean', default: false },
    'exit-on-stdin-close': { type: 'boolean', default: false },
  },
});

const count = Number(values.peers);
const lite = Number(values.lite);
if (
  !Number.isInteger(count) ||
  count < 0 ||
  count > 500 ||
  !Number.isInteger(lite) ||
  lite < 0 ||
  lite > 1000
) {
  console.error('--peers must be 0-500 and --lite 0-1000');
  process.exit(2);
}
const loopbackOnly = values.lan !== 'all';
if (!loopbackOnly)
  console.warn(
    'WARNING: --lan=all: these colleagues are visible on the real network, and any InterCom running there will remember them.',
  );
const discoveryPort =
  values['discovery-port'] !== undefined ? Number(values['discovery-port']) : undefined;

const started = Date.now();
let full: ProcessSim | undefined;
let lites: LiteSim | undefined;
if (count > 0) {
  full = await startProcessPeers({
    count,
    loopbackOnly,
    echo: values.echo,
    ...(discoveryPort !== undefined && { discoveryPort }),
    ...(values['data-root'] !== undefined && { dataRoot: values['data-root'] }),
    keepData: values.keep,
  });
  console.log(`started ${full.peers.length} full peers (data: ${full.dataRoot})`);
  console.table(
    full.peers.map((p) => ({
      profile: p.profile,
      name: p.identity.displayName,
      userId: p.identity.userId,
      pid: p.pid,
    })),
  );
}
if (lite > 0) {
  lites = await startLitePeers({
    count: lite,
    loopbackOnly,
    nameOffset: count,
    ...(discoveryPort !== undefined && { discoveryPort }),
  });
  console.log(`started ${lite} lite peers`);
}
console.log(`ready in ${Date.now() - started} ms. Ctrl+C to stop.`);

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await Promise.all([full?.stop(), lites?.stop()]);
  console.log('stopped');
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
// For tests that spawn the sim: closing our stdin shuts it down cleanly.
if (values['exit-on-stdin-close']) {
  process.stdin.on('end', () => void shutdown());
  process.stdin.resume();
}
