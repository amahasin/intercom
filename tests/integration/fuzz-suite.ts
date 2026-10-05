import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fuzzRun } from './fuzz.ts';

export const SHARDS = 6;

/**
 * Replay the saved regression seeds whose index falls in this shard, at full size. The
 * seeds are spread over several test files so Vitest runs them in parallel.
 */
export function regressionShard(shard: number): void {
  const seeds = (
    JSON.parse(
      readFileSync(new URL('./fuzz-regressions.json', import.meta.url), 'utf8'),
    ) as number[]
  ).filter((_, i) => i % SHARDS === shard);
  describe(`M3 randomised sync: regression seeds (shard ${shard + 1} of ${SHARDS})`, () => {
    if (seeds.length === 0) it.skip('no saved seeds in this shard', () => {});
    for (const seed of seeds) {
      it(`seed ${seed} converges`, { timeout: 600_000 }, async () => {
        const result = await fuzzRun(seed, { peers: 10, ops: 2_000 });
        expect(result.problems).toEqual([]);
      });
    }
  });
}
