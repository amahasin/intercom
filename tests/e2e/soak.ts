/**
 * Soak run (M6 done-when): the app with 50 simulated colleagues (full cores in their own
 * processes, real TLS and UDP on loopback) for many hours. Colleagues and the app chat
 * directly and in a group of everyone, change presence, and quit and come back. Every 5
 * minutes the app's memory (all its processes) is sampled and it is checked for crashes.
 *
 *   node tests/e2e/soak.ts [--hours=24] [--peers=50] [--out=test-results/soak.json]
 *
 * Memory growth = mean of the last 3 samples minus the mean over the first hour after a
 * 30-minute warm-up (database caches and the people list fill up first).
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { _electron as electron, type Page } from '@playwright/test';
// Loaded at run time: its sources are Node code, outside this browser-typed project.
interface ProcessSim {
  peers: Array<{ identity: { userId: string } }>;
  act(index: number, action: Record<string, unknown>): Promise<unknown>;
  restart(index: number): Promise<unknown>;
  stop(): Promise<void>;
}
const simModule = '@officemesh/sim';
const { startProcessPeers } = (await import(simModule)) as {
  startProcessPeers(o: {
    count: number;
    discoveryPort: number;
    loopbackOnly: boolean;
  }): Promise<ProcessSim>;
};
import { appDir, electronPath, lanArgs, randomPort, tempDataRoot } from './app.ts';

const arg = (name: string, def: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? def;
const HOURS = Number(arg('hours', '24'));
const PEERS = Number(arg('peers', '50'));
const OUT = arg('out', 'test-results/soak.json');
const LOG = OUT.replace(/\.json$/, '.log');
const SAMPLE_MS = Number(arg('sample-minutes', '5')) * 60_000;
const WARMUP_MS = Number(arg('warmup-minutes', '30')) * 60_000;

const log = (line: string) => {
  const text = `${new Date().toISOString()} ${line}`;
  console.log(text);
  appendFileSync(LOG, text + '\n');
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]!;

async function invoke<T>(page: Page, name: string, args: unknown): Promise<T> {
  return page.evaluate(
    ([name, args]) =>
      new Promise<unknown>((resolve, reject) => {
        const api = (
          window as unknown as {
            officemesh: {
              send(f: unknown): void;
              onFrame(
                l: (f: {
                  kind: string;
                  id?: number;
                  ok?: boolean;
                  result?: unknown;
                  error?: { message: string };
                }) => void,
              ): () => void;
            };
          }
        ).officemesh;
        const id = 1_000_000_000 + Math.floor(Math.random() * 1e9);
        const timer = setTimeout(() => reject(new Error(`${name} timed out`)), 30_000);
        const off = api.onFrame((f) => {
          if (f.kind !== 'res' || f.id !== id) return;
          off();
          clearTimeout(timer);
          if (f.ok) resolve(f.result);
          else reject(new Error(f.error?.message ?? 'failed'));
        });
        api.send({ kind: 'req', id, name, args });
      }),
    [name, args] as const,
  ) as Promise<T>;
}

const report: Record<string, unknown> = {
  hours: HOURS,
  peers: PEERS,
  startedAt: new Date().toISOString(),
};
const samples: Array<{
  minutes: number;
  totalMb: number;
  byType: Record<string, number>;
  online: number;
  messages: number;
}> = [];
const crashes: string[] = [];
writeFileSync(LOG, '');

const root = tempDataRoot();
const port = randomPort();
const sim = await startProcessPeers({ count: PEERS, discoveryPort: port, loopbackOnly: true });
log(`started ${PEERS} colleagues`);
const app = await electron.launch({
  executablePath: electronPath,
  args: [appDir, '--profile=soak', `--data-root=${root.path}`, ...lanArgs(port)],
});
app.process().on('exit', (code) => crashes.push(`app exited (code ${code})`));
const page = await app.firstWindow();
page.on('crash', () => crashes.push('renderer crashed'));
const started = Date.now();
let sent = 0;

try {
  const people = () => invoke<Array<{ userId: string; online: boolean }>>(page, 'people.list', {});
  for (;;) {
    const online = (await people()).filter((p) => p.online).length;
    if (online >= PEERS) break;
    if (Date.now() - started > 120_000) throw new Error(`only ${online} colleagues online`);
    await sleep(2_000);
  }
  const ids = sim.peers.map((p) => p.identity.userId);
  const me = await invoke<{ userId: string }>(page, 'identity.get', {});
  const group = (
    await invoke<{ convId: string }>(page, 'groups.create', { members: ids, title: 'Soak' })
  ).convId;
  log(`everyone online; group ${group}`);

  const end = started + HOURS * 3_600_000;
  let tick = 0;
  let nextSample = Date.now();
  while (Date.now() < end && crashes.length === 0) {
    tick++;
    // Colleagues write to the app and to the group; the app writes back.
    for (let i = 0; i < 2; i++)
      await sim
        .act(Math.floor(Math.random() * PEERS), {
          op: 'dm',
          userId: me.userId,
          text: `soak ${tick}.${i}`,
        })
        .catch(() => {});
    await sim
      .act(Math.floor(Math.random() * PEERS), { op: 'post', convId: group, text: `group ${tick}` })
      .catch(() => {});
    const conv = await invoke<{ convId: string }>(page, 'conversations.openDirect', {
      userId: pick(ids),
    });
    await invoke(page, 'messages.send', { convId: conv.convId, text: `reply ${tick}` });
    if (tick % 3 === 0) await invoke(page, 'messages.send', { convId: group, text: `app ${tick}` });
    sent += 5;
    if (tick % 6 === 0)
      await sim
        .act(Math.floor(Math.random() * PEERS), {
          op: 'presence',
          state: pick(['available', 'busy', 'away', 'dnd', 'brb'] as const),
        })
        .catch(() => {});
    // A colleague quits and comes back every 5 minutes.
    if (tick % 30 === 0)
      await sim
        .restart(Math.floor(Math.random() * PEERS))
        .catch((e: unknown) => log(`restart failed: ${String(e)}`));

    if (Date.now() >= nextSample) {
      nextSample += SAMPLE_MS;
      const metrics = await app.evaluate(({ app: a }) =>
        a.getAppMetrics().map((m) => ({ type: m.type, kb: m.memory.workingSetSize })),
      );
      const byType: Record<string, number> = {};
      for (const m of metrics)
        byType[m.type] = Math.round(((byType[m.type] ?? 0) + m.kb / 1024) * 10) / 10;
      const totalMb = Math.round(Object.values(byType).reduce((a, b) => a + b, 0));
      const onlineNow = (await people()).filter((p) => p.online).length;
      if (!metrics.some((m) => m.type === 'Utility')) crashes.push('core process gone');
      const sample = {
        minutes: Math.round((Date.now() - started) / 60_000),
        totalMb,
        byType,
        online: onlineNow,
        messages: sent,
      };
      samples.push(sample);
      log(JSON.stringify(sample));
      writeFileSync(OUT, JSON.stringify({ ...report, samples, crashes, running: true }, null, 2));
    }
    await sleep(10_000);
  }
} catch (err) {
  crashes.push(`harness: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const base = samples.filter(
    (s) => s.minutes * 60_000 >= WARMUP_MS && s.minutes * 60_000 < WARMUP_MS + 3_600_000,
  );
  const baseline = mean((base.length ? base : samples.slice(0, 3)).map((s) => s.totalMb));
  const final = mean(samples.slice(-3).map((s) => s.totalMb));
  report['endedAt'] = new Date().toISOString();
  report['hoursRun'] = Math.round(((Date.now() - started) / 3_600_000) * 100) / 100;
  report['messagesSent'] = sent;
  report['baselineMb'] = Math.round(baseline);
  report['finalMb'] = Math.round(final);
  report['growthMb'] = Math.round(final - baseline);
  report['crashes'] = crashes;
  report['passed'] =
    crashes.length === 0 && final - baseline < 50 && (report['hoursRun'] as number) >= HOURS * 0.99;
  writeFileSync(OUT, JSON.stringify({ ...report, samples }, null, 2));
  log(`done: ${JSON.stringify(report)}`);
  await app.close().catch(() => {});
  await sim.stop();
  root.dispose();
  process.exit(report['passed'] ? 0 : 1);
}
