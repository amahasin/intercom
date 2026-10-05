/**
 * Host-relay load test (M6 done-when): a whole-office meeting of simulated participants
 * with fake media on host relay, for a set time, then the host is killed.
 *
 *   node tools/sim/src/relay-load/run.ts [--people=100] [--minutes=30] [--out=<file.json>]
 *
 * Two hosts (full cores) and the rest as simulated participants in a few processes. The
 * first host is pinned to 8 logical cores (the plan's minimum relay host) and its CPU is
 * reported as a share of those 8; the second host (pinned to the next 8) takes over when
 * the first is killed. Participants run on the remaining cores. Reports CPU, media flow
 * and the time until everyone is receiving media again after the kill.
 */
import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (name: string, def: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? def;
const PEOPLE = Number(arg('people', '100'));
const MINUTES = Number(arg('minutes', '30'));
const OUT = arg('out', '');
const SPEAKERS = Number(arg('speakers', '20'));
const CAMERAS = Number(arg('cameras', '16'));
const HOST_CORES = 8;
const PROCS = 4;

const dir = import.meta.dirname;
const root = mkdtempSync(join(tmpdir(), 'officemesh-relay-load-'));
const discoveryPort = 48_000 + Math.floor(Math.random() * 1_000);
const children: ChildProcess[] = [];
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** CPU seconds Windows has charged to these processes so far (a cross-check of the host's own figures). */
function osCpuSeconds(pids: number[]): number {
  if (process.platform !== 'win32' || pids.length === 0) return 0;
  const out = execFileSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `$s = 0; Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { $s += $_.TotalProcessorTime.TotalSeconds }; [string]::Format([cultureinfo]::InvariantCulture, '{0}', $s)`,
  ]).toString();
  return Number(out.trim().replace(',', '.')) || 0;
}

function pin(pid: number, mask: bigint): void {
  if (process.platform !== 'win32') return;
  execFileSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `(Get-Process -Id ${pid}).ProcessorAffinity = [IntPtr]${mask}`,
  ]);
}

class Host {
  readonly child: ChildProcess;
  userId = '';
  pid = 0;
  private next = 1;
  private readonly waiting = new Map<number, (r: { data: unknown; error?: string }) => void>();
  readonly ready: Promise<void>;

  constructor(name: string, score: number) {
    this.child = fork(
      join(dir, 'host.ts'),
      [
        `--data-dir=${join(root, name)}`,
        `--profile=${name}`,
        `--name=${name}`,
        `--discovery-port=${discoveryPort}`,
        `--score=${score}`,
        `--workers=${HOST_CORES}`,
      ],
      { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] },
    );
    children.push(this.child);
    this.ready = new Promise((resolve) => {
      this.child.on(
        'message',
        (m: {
          type: string;
          id?: number;
          data?: unknown;
          error?: string;
          userId?: string;
          pid?: number;
        }) => {
          if (m.type === 'ready') {
            this.userId = m.userId!;
            this.pid = m.pid!;
            resolve();
          } else if (m.type === 'reply') {
            this.waiting.get(m.id!)?.({ data: m.data, ...(m.error && { error: m.error }) });
            this.waiting.delete(m.id!);
          }
        },
      );
    });
  }

  async call<T>(op: string, extra: Record<string, unknown> = {}): Promise<T> {
    const id = this.next++;
    const r = await new Promise<{ data: unknown; error?: string }>((resolve) => {
      this.waiting.set(id, resolve);
      this.child.send({ id, op, ...extra });
    });
    if (r.error) throw new Error(`${op}: ${r.error}`);
    return r.data as T;
  }
}

interface SimStat {
  index: number;
  userId: string;
  inCall: boolean;
  host: string | null;
  epoch: number;
  reconnecting: boolean | null;
  participants: number;
  bytesIn: number;
  lastIn: number;
  firstIn: number;
  audio: number;
  video: number;
}

class Participants {
  readonly child: ChildProcess;
  userIds: string[] = [];
  pid = 0;
  readonly ready: Promise<void>;
  private pending: ((s: { sims: SimStat[]; rssMb: number }) => void) | undefined;

  constructor(first: number, count: number) {
    const range = (n: number) =>
      Array.from({ length: count }, (_, k) => first + k)
        .filter((i) => i < n)
        .join(',');
    this.child = fork(
      join(dir, 'participants.ts'),
      [
        `--count=${count}`,
        `--first=${first}`,
        `--discovery-port=${discoveryPort}`,
        `--speakers=${range(SPEAKERS)}`,
        `--cameras=${range(CAMERAS)}`,
      ],
      { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] },
    );
    children.push(this.child);
    this.ready = new Promise((resolve) => {
      this.child.on(
        'message',
        (m: {
          type: string;
          userIds?: string[];
          pid?: number;
          text?: string;
          sims?: SimStat[];
          rssMb?: number;
        }) => {
          if (m.type === 'ready') {
            this.userIds = m.userIds!;
            this.pid = m.pid!;
            resolve();
          } else if (m.type === 'stats') {
            this.pending?.({ sims: m.sims!, rssMb: m.rssMb! });
            this.pending = undefined;
          } else if (m.type === 'log') log(m.text);
        },
      );
    });
  }

  stats(): Promise<{ sims: SimStat[]; rssMb: number }> {
    return new Promise((resolve) => {
      this.pending = resolve;
      this.child.send({ op: 'stats' });
    });
  }
}

async function allStats(groups: Participants[]): Promise<SimStat[]> {
  return (await Promise.all(groups.map((g) => g.stats()))).flatMap((s) => s.sims);
}

async function until(cond: () => Promise<boolean>, maxMs: number, what: string): Promise<number> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > maxMs) throw new Error(`${what}: not within ${maxMs} ms`);
    await sleep(250);
  }
  return Date.now() - start;
}

const report: Record<string, unknown> = {
  people: PEOPLE,
  minutes: MINUTES,
  speakers: SPEAKERS,
  cameras: CAMERAS,
  machineCores: availableParallelism(),
  hostCores: HOST_CORES,
  startedAt: new Date().toISOString(),
};

try {
  const h1 = new Host('host-1', 2_000);
  const h2 = new Host('host-2', 1_500);
  await Promise.all([h1.ready, h2.ready]);
  // The first host on cores 0-7, the second on 8-15, participants on the rest. Workers
  // started later inherit their host's affinity.
  pin(h1.pid, 0xffn);
  pin(h2.pid, 0xff00n);
  const simCount = PEOPLE - 2;
  const per = Math.ceil(simCount / PROCS);
  const groups: Participants[] = [];
  for (let p = 0; p < PROCS; p++) {
    const first = p * per;
    const count = Math.min(per, simCount - first);
    if (count > 0) groups.push(new Participants(first, count));
  }
  await Promise.all(groups.map((g) => g.ready));
  const rest = (1n << BigInt(availableParallelism())) - 1n - 0xffffn;
  for (const g of groups) pin(g.pid, rest > 0n ? rest : 0xffn);
  const simIds = groups.flatMap((g) => g.userIds);
  log(`started ${simIds.length} participants and 2 hosts`);

  await until(async () => (await h1.call<number>('people')) >= PEOPLE - 1, 60_000, 'discovery');
  const convId = await h1.call<string>('group', { members: [...simIds, h2.userId] });
  await until(() => h2.call<boolean>('hasGroup', { convId }), 30_000, 'group at host 2');
  const callId = await h1.call<string>('meetNow', { convId });
  let card: { author: string; seq: number } | null = null;
  await until(async () => (card = await h2.call('card', { convId })) !== null, 30_000, 'card');
  await h2.call('join', { convId, target: card });
  log('meeting started; participants joining');
  const joinStart = Date.now();
  groups.forEach((g, p) =>
    setTimeout(
      () =>
        g.child.send({ op: 'join', callId, convId, via: [h1.userId, h2.userId], spacingMs: 400 }),
      p * 100,
    ),
  );
  let lastProgress = 0;
  const everyoneIn = async (host: string, after = 0) => {
    const sims = await allStats(groups);
    if (Date.now() - lastProgress > 5_000) {
      lastProgress = Date.now();
      const c = (f: (s: SimStat) => boolean) => sims.filter(f).length;
      log(
        `in call ${c((s) => s.inCall)}, on host ${c((s) => s.host === host)}, joined ${c((s) => s.reconnecting === false)}, media ${c((s) => s.lastIn > after && s.bytesIn > 0)}, consumers a/v ${c((s) => s.audio > 0)}/${c((s) => s.video > 0)}, roster seen ${Math.min(...sims.map((s) => s.participants))}`,
      );
      const by = new Map<string, number>();
      for (const s of sims) {
        const k = `${s.host === host ? 'H' : s.host ? s.host.slice(0, 4) : '-'}@${s.epoch}/${s.reconnecting}`;
        by.set(k, (by.get(k) ?? 0) + 1);
      }
      log('  hosts:', JSON.stringify(Object.fromEntries(by)));
      const out = sims.filter((s) => !s.inCall).map((s) => s.index);
      if (out.length && out.length < 20) log('  not in call:', out.join(','));
    }
    return sims.every(
      (s) =>
        s.inCall &&
        s.host === host &&
        s.reconnecting === false &&
        s.lastIn > after &&
        s.bytesIn > 0,
    );
  };
  report['joinAllMs'] = await until(
    () => everyoneIn(h1.userId),
    180_000,
    'everyone in, with media',
  );
  const roster = await h1.call<{ participants: number }>('call');
  report['rosterAtStart'] = roster.participants;
  log(`all ${PEOPLE} in after ${report['joinAllMs']} ms; roster ${roster.participants}`);

  // The run: sample the host's CPU (its process and its workers) and everyone's media.
  type Relay = {
    stats: {
      workerCpuMs: number;
      consumers: number;
      producers: number;
      sendMbps: number;
      recvMbps: number;
      workers: number;
      participants: number;
    };
    procCpuMs: number;
    rssMb: number;
  };
  const samples: Array<Record<string, number>> = [];
  const first = await h1.call<Relay & { workerPids: number[] }>('relay');
  let prev: Relay = first;
  let prevAt = Date.now();
  const hostPids = [h1.pid, ...first.workerPids];
  const osStart = osCpuSeconds(hostPids);
  const runStart = Date.now();
  const end = Date.now() + MINUTES * 60_000;
  let worstFlow = PEOPLE;
  let dropped = 0;
  while (Date.now() < end) {
    await sleep(10_000);
    const now = Date.now();
    const cur = await h1.call<Relay>('relay');
    const cpuMs = cur.stats.workerCpuMs - prev.stats.workerCpuMs + (cur.procCpuMs - prev.procCpuMs);
    const cpuPercent = (cpuMs / (now - prevAt) / HOST_CORES) * 100;
    prev = cur;
    prevAt = now;
    const sims = await allStats(groups);
    const flowing = sims.filter((s) => now - s.lastIn < 3_000).length;
    const inCall = sims.filter((s) => s.inCall && s.host === h1.userId).length;
    worstFlow = Math.min(worstFlow, flowing);
    dropped = Math.max(dropped, simIds.length - inCall);
    const sample = {
      t: Math.round((now - joinStart) / 1000),
      cpuPercent: Math.round(cpuPercent * 10) / 10,
      sendMbps: cur.stats.sendMbps,
      recvMbps: cur.stats.recvMbps,
      participants: cur.stats.participants,
      consumers: cur.stats.consumers,
      workers: cur.stats.workers,
      flowing,
      inCall,
      hostRssMb: cur.rssMb,
    };
    samples.push(sample);
    log(JSON.stringify(sample));
  }
  const osUsed = osCpuSeconds(hostPids) - osStart;
  report['osCpuPercent'] =
    Math.round(((osUsed * 1000) / (Date.now() - runStart) / HOST_CORES) * 1000) / 10;
  const cpus = samples.map((s) => s.cpuPercent!);
  report['samples'] = samples;
  report['cpuPercentMax'] = Math.max(...cpus);
  report['cpuPercentMean'] = Math.round((cpus.reduce((a, b) => a + b, 0) / cpus.length) * 10) / 10;
  report['minParticipantsReceiving'] = worstFlow;
  report['maxDropped'] = dropped;

  // Kill the host's PC (its process tree, workers included) and time the recovery.
  log('killing host 1');
  const killedAt = Date.now();
  execFileSync('taskkill', ['/F', '/T', '/PID', String(h1.pid)]);
  report['recoveryMs'] = await until(
    () => everyoneIn(h2.userId, killedAt),
    30_000,
    'recovery after the host was killed',
  );
  // When media actually resumed, by each participant's own clock reading (not when we polled).
  const resumed = (await allStats(groups)).map((s) => s.firstIn - killedAt);
  report['recoveryPolledMs'] = report['recoveryMs'];
  report['recoveryMs'] = Math.max(...resumed);
  report['recoveryMedianMs'] = resumed.sort((x, y) => x - y)[Math.floor(resumed.length / 2)];
  const after = await h2.call<{ relay: { epoch: number } | null; participants: number }>('call');
  report['epochAfter'] = after.relay?.epoch ?? null;
  report['rosterAfter'] = after.participants;
  log(`recovered in ${report['recoveryMs']} ms; roster ${after.participants}`);
  report['passed'] =
    (report['cpuPercentMax'] as number) < 70 &&
    (report['recoveryMs'] as number) < 10_000 &&
    dropped === 0;
} catch (err) {
  report['error'] = err instanceof Error ? err.message : String(err);
  report['passed'] = false;
} finally {
  report['endedAt'] = new Date().toISOString();
  const { samples, ...summary } = report;
  console.log(JSON.stringify(summary, null, 2));
  void samples;
  if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 2));
  for (const c of children) if (c.exitCode === null) c.kill();
  await sleep(2_000);
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  process.exit(report['passed'] ? 0 : 1);
}
