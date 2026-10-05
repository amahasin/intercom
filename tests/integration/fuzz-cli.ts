// Replay one randomised sync run with progress output: node tests/integration/fuzz-cli.ts <seed> [ops] [peers]
import { fuzzRun } from './fuzz.ts';

const [seed = '1000', ops = '2000', peers = '10'] = process.argv.slice(2);
const started = Date.now();
const result = await fuzzRun(Number(seed), {
  ops: Number(ops),
  peers: Number(peers),
  progress: (m) => console.log(`${((Date.now() - started) / 1000).toFixed(1)}s ${m}`),
});
console.log(JSON.stringify({ ...result, wallMs: Date.now() - started }, null, 2));
process.exit(result.converged ? 0 : 1);
