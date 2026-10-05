// The full randomised sync run (plan M3): 100 seeds of 10 peers and 2,000 events, spread
// over worker processes. Failing seeds are added to fuzz-regressions.json, which
// `pnpm test` replays every time.  Usage: node tests/integration/fuzz-all.ts [seeds] [workers]
import { fork } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [count = '100', workers = String(Math.max(1, Math.min(8, availableParallelism() - 2)))] =
  process.argv.slice(2);
const seeds = Array.from({ length: Number(count) }, (_, i) => 1_000 + i);
const cli = fileURLToPath(new URL('./fuzz-cli.ts', import.meta.url));
const regressionsFile = new URL('./fuzz-regressions.json', import.meta.url);
const started = Date.now();
const failed: number[] = [];
let done = 0;

async function worker(): Promise<void> {
  for (let seed = seeds.shift(); seed !== undefined; seed = seeds.shift()) {
    const ok = await new Promise<boolean>((resolve) => {
      const child = fork(cli, [String(seed), '2000', '10'], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      let out = '';
      child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr!.on('data', (d: Buffer) => (out += d.toString()));
      child.on('exit', (code) => {
        if (code !== 0)
          console.log(
            `seed ${seed} FAILED\n${out
              .split('\n')
              .filter((l) => !/^\d+\.\ds step/.test(l))
              .join('\n')}`,
          );
        resolve(code === 0);
      });
    });
    done++;
    if (!ok) failed.push(seed);
    console.log(
      `${done}/${count} seed ${seed} ${ok ? 'ok' : 'FAILED'} (${Math.round((Date.now() - started) / 1000)}s)`,
    );
  }
}

await Promise.all(Array.from({ length: Number(workers) }, () => worker()));
if (failed.length) {
  const saved = JSON.parse(readFileSync(regressionsFile, 'utf8')) as number[];
  const merged = [...new Set([...saved, ...failed])].sort((a, b) => a - b);
  writeFileSync(regressionsFile, JSON.stringify(merged) + '\n');
}
console.log(
  `${Number(count) - failed.length}/${count} seeds converged in ${Math.round((Date.now() - started) / 1000)}s` +
    (failed.length ? `; failing: ${failed.join(', ')}` : ''),
);
process.exit(failed.length ? 1 : 0);
