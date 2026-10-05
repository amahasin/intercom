import { describe, expect, it } from 'vitest';
import { fuzzRun } from './fuzz.ts';

/**
 * Randomised sync test (plan M3). `pnpm test` runs two fresh seeds at a quicker size here
 * and replays every saved regression seed at full size (m3-fuzz-regressions-*.test.ts);
 * the full run of 100 seeds of 10 peers and 2,000 events is `pnpm test:fuzz`
 * (fuzz-all.ts), which saves any failing seed to fuzz-regressions.json.
 */
describe('M3 randomised sync', () => {
  for (const seed of [1, 2]) {
    it(`quick seed ${seed} converges`, { timeout: 300_000 }, async () => {
      const result = await fuzzRun(seed, { peers: 10, ops: 500 });
      expect(result.problems).toEqual([]);
      expect(result.applied).toBeGreaterThan(250);
    });
  }
});
