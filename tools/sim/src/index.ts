import { fork, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core, silentLogger, type Clock, type CoreOptions, type Logger } from '@officemesh/core';
import { InsecureTestKeyProtector, LoopbackDiscoveryHub } from '@officemesh/core/testing';
import { MemoryNetwork } from '@officemesh/core';
import type { IdentityView } from '@officemesh/protocol/ipc';
import type { PeerAction, PeerToSim, SimToPeer } from './messages.ts';
export type { PeerAction } from './messages.ts';
import { simName, simProfile } from './names.ts';

export { simName, simProfile } from './names.ts';
export { SimMediaClient, type SimMediaStats, type RelayRequest } from './relay-media.ts';
export { startLitePeers, type LiteOptions, type LiteSim } from './lite.ts';

const PEER_ENTRY = join(import.meta.dirname, 'peer.ts');

export interface SimOptions {
  count: number;
  /** Folder holding one sub-folder per peer. Defaults to a fresh temp folder, removed on stop. */
  dataRoot?: string;
  /** Keep the data folder after stop (only applies to a temp folder). */
  keepData?: boolean;
}

export interface ProcessSimOptions extends SimOptions {
  discoveryPort?: number;
  /** Beacon and listen on loopback only (one-PC demos and tests). */
  loopbackOnly?: boolean;
  /** Peers reply to every message they receive. */
  echo?: boolean;
}

export interface SimProcessPeer {
  index: number;
  profile: string;
  dataDir: string;
  pid: number;
  identity: IdentityView;
}

export interface ProcessSim {
  dataRoot: string;
  peers: SimProcessPeer[];
  /** Run a scripted action on peer `index` (soak runs). */
  act(index: number, action: PeerAction): Promise<unknown>;
  /** Quit peer `index` cleanly and start it again from its data (churn). */
  restart(index: number): Promise<SimProcessPeer>;
  stop(): Promise<void>;
}

/** Start `count` headless core peers, each in its own bare Node process. */
export async function startProcessPeers(options: ProcessSimOptions): Promise<ProcessSim> {
  const ownsRoot = options.dataRoot === undefined;
  const dataRoot = options.dataRoot ?? mkdtempSync(join(tmpdir(), 'officemesh-sim-'));
  mkdirSync(dataRoot, { recursive: true });
  const children: ChildProcess[] = [];
  const byIndex = new Map<number, ChildProcess>();
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextAct = 1;

  const startOne = (index: number) =>
    new Promise<SimProcessPeer>((resolve, reject) => {
      const profile = simProfile(index);
      const dataDir = join(dataRoot, profile);
      const args = [`--data-dir=${dataDir}`, `--profile=${profile}`, `--name=${simName(index)}`];
      if (options.discoveryPort !== undefined)
        args.push(`--discovery-port=${options.discoveryPort}`);
      if (options.loopbackOnly) args.push('--lan=loopback');
      if (options.echo) args.push('--echo');
      const child = fork(PEER_ENTRY, args, {
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      children.push(child);
      byIndex.set(index, child);
      child.on('message', (message: PeerToSim) => {
        if (message.type !== 'done') return;
        const w = waiting.get(message.id);
        waiting.delete(message.id);
        if (message.error) w?.reject(new Error(message.error));
        else w?.resolve(message.result);
      });
      child.once('message', (message: PeerToSim) => {
        if (message.type === 'ready') {
          resolve({ index, profile, dataDir, pid: message.pid, identity: message.identity });
        } else {
          if (message.type === 'error') reject(new Error(`${profile}: ${message.message}`));
        }
      });
      child.once('exit', (code) =>
        reject(new Error(`${profile} exited during start-up (code ${code})`)),
      );
    });

  const stopChild = (child: ChildProcess) =>
    new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(() => child.kill(), 5_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.send({ type: 'stop' } satisfies SimToPeer);
    });

  const act = (index: number, action: PeerAction) =>
    new Promise<unknown>((resolve, reject) => {
      const child = byIndex.get(index);
      if (!child?.connected) return reject(new Error(`peer ${index} is not running`));
      const id = nextAct++;
      waiting.set(id, { resolve, reject });
      child.send({ type: 'act', id, ...action } satisfies SimToPeer);
    });

  const restart = async (index: number) => {
    const child = byIndex.get(index);
    if (child) await stopChild(child);
    return startOne(index);
  };

  const stop = async () => {
    await Promise.all(children.map(stopChild));
    if (ownsRoot && !options.keepData)
      rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5 });
  };

  try {
    const peers = await Promise.all(Array.from({ length: options.count }, (_, i) => startOne(i)));
    return { dataRoot, peers, act, restart, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

export interface InProcessPeer {
  index: number;
  /** Address on the simulated LAN segment. */
  address: string;
  dataDir: string;
  core: Core;
}

export interface InProcessSimOptions extends SimOptions {
  clock?: Clock;
  logger?: Logger;
  /** Give each peer discovery (loopback hub) and links (memory network). Default true. */
  network?: boolean;
  /** Display name for peer `index` (defaults to the sample names). */
  name?: (index: number) => string;
  /** Extra core options for peer `index` (relay settings in host-relay tests). */
  coreOptions?: (index: number) => Partial<CoreOptions>;
  /**
   * Put peer `index` on a subnet (default 0). Beacons stay inside a subnet, as multicast
   * does not cross routers; links between subnets still connect (they are routed).
   */
  subnet?: (index: number) => number;
}

export interface InProcessSim {
  dataRoot: string;
  hub: LoopbackDiscoveryHub;
  net: MemoryNetwork;
  peers: InProcessPeer[];
  /** Start (or restart) peer `index` from its data folder. */
  startPeer(index: number): Promise<InProcessPeer>;
  /** Quit peer `index` cleanly (it says bye). */
  stopPeer(index: number): Promise<void>;
  /** Cut peer `index` off the LAN without any goodbye, as with a pulled cable or power loss. */
  unplug(index: number): void;
  replug(index: number): void;
  stop(): Promise<void>;
}

/**
 * Start `count` cores inside this process on one simulated LAN segment (loopback beacons,
 * in-memory links) sharing an optional fake clock. Multi-peer integration tests build on it.
 */
export async function startInProcessPeers(options: InProcessSimOptions): Promise<InProcessSim> {
  const ownsRoot = options.dataRoot === undefined;
  const dataRoot = options.dataRoot ?? mkdtempSync(join(tmpdir(), 'officemesh-sim-'));
  const hub = new LoopbackDiscoveryHub();
  const net = new MemoryNetwork();
  const peers: InProcessPeer[] = [];
  const unplugged = new Set<string>();
  const subnetOf = options.subnet ?? (() => 0);
  const addressOf = (index: number) =>
    `10.${subnetOf(index)}.${Math.floor(index / 250)}.${(index % 250) + 1}`;
  const prefix = (address: string) => address.split('.').slice(0, 2).join('.');
  hub.canDeliver = (from, to) =>
    !unplugged.has(from) && !unplugged.has(to) && prefix(from) === prefix(to);
  net.canConnect = (a, b) => !unplugged.has(a) && !unplugged.has(b);

  const startPeer = async (index: number): Promise<InProcessPeer> => {
    const address = addressOf(index);
    const dataDir = join(dataRoot, simProfile(index));
    const core = await Core.start({
      dataDir,
      profile: simProfile(index),
      appVersion: 'sim',
      keyProtector: new InsecureTestKeyProtector(),
      // Each simulated PC has its own file store, as separate PCs would.
      filesDir: join(dataDir, 'files'),
      logger: options.logger ?? silentLogger,
      defaultDisplayName: async () => (options.name ?? simName)(index),
      ...options.coreOptions?.(index),
      ...(options.clock && { clock: options.clock }),
      ...(options.network !== false && {
        network: {
          discovery: hub.createDriver(address),
          transport: (identity) => net.transport(address, identity),
        },
      }),
    });
    const peer = { index, address, dataDir, core };
    peers[index] = peer;
    return peer;
  };

  const stopPeer = async (index: number) => {
    const peer = peers[index];
    if (!peer) return;
    delete peers[index];
    await peer.core.close();
  };

  const stop = async () => {
    await Promise.all(peers.filter(Boolean).map((p) => p.core.close()));
    if (ownsRoot && !options.keepData)
      rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5 });
  };

  try {
    for (let index = 0; index < options.count; index++) await startPeer(index);
  } catch (err) {
    await stop();
    throw err;
  }
  return {
    dataRoot,
    hub,
    net,
    peers,
    startPeer,
    stopPeer,
    unplug: (index) => {
      unplugged.add(addressOf(index));
    },
    replug: (index) => {
      unplugged.delete(addressOf(index));
    },
    stop,
  };
}
