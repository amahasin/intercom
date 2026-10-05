import { fork, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core, silentLogger, type Clock, type Logger } from '@officemesh/core';
import { InsecureTestKeyProtector, LoopbackDiscoveryHub } from '@officemesh/core/testing';
import type { IdentityView } from '@officemesh/protocol/ipc';
import type { PeerToSim, SimToPeer } from './messages.ts';
import { simName, simProfile } from './names.ts';

export { simName, simProfile } from './names.ts';

const PEER_ENTRY = join(import.meta.dirname, 'peer.ts');

export interface SimOptions {
  count: number;
  /** Folder holding one sub-folder per peer. Defaults to a fresh temp folder, removed on stop. */
  dataRoot?: string;
  /** Keep the data folder after stop (only applies to a temp folder). */
  keepData?: boolean;
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
  stop(): Promise<void>;
}

/** Start `count` headless core peers, each in its own bare Node process. */
export async function startProcessPeers(options: SimOptions): Promise<ProcessSim> {
  const ownsRoot = options.dataRoot === undefined;
  const dataRoot = options.dataRoot ?? mkdtempSync(join(tmpdir(), 'officemesh-sim-'));
  mkdirSync(dataRoot, { recursive: true });
  const children: ChildProcess[] = [];

  const startOne = (index: number) =>
    new Promise<SimProcessPeer>((resolve, reject) => {
      const profile = simProfile(index);
      const dataDir = join(dataRoot, profile);
      const child = fork(
        PEER_ENTRY,
        [`--data-dir=${dataDir}`, `--profile=${profile}`, `--name=${simName(index)}`],
        {
          stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        },
      );
      children.push(child);
      child.once('message', (message: PeerToSim) => {
        if (message.type === 'ready') {
          resolve({ index, profile, dataDir, pid: message.pid, identity: message.identity });
        } else {
          reject(new Error(`${profile}: ${message.message}`));
        }
      });
      child.once('exit', (code) =>
        reject(new Error(`${profile} exited during start-up (code ${code})`)),
      );
    });

  const stop = async () => {
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            const timer = setTimeout(() => child.kill(), 5_000);
            child.once('exit', () => {
              clearTimeout(timer);
              resolve();
            });
            child.send({ type: 'stop' } satisfies SimToPeer);
          }),
      ),
    );
    if (ownsRoot && !options.keepData)
      rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5 });
  };

  try {
    const peers = await Promise.all(Array.from({ length: options.count }, (_, i) => startOne(i)));
    return { dataRoot, peers, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

export interface InProcessPeer {
  index: number;
  core: Core;
}

export interface InProcessSim {
  dataRoot: string;
  hub: LoopbackDiscoveryHub;
  peers: InProcessPeer[];
  stop(): Promise<void>;
}

/**
 * Start `count` cores inside this process, sharing a loopback discovery segment and an
 * optional fake clock. This is the harness the multi-peer integration tests build on.
 */
export async function startInProcessPeers(
  options: SimOptions & { clock?: Clock; logger?: Logger },
): Promise<InProcessSim> {
  const ownsRoot = options.dataRoot === undefined;
  const dataRoot = options.dataRoot ?? mkdtempSync(join(tmpdir(), 'officemesh-sim-'));
  const hub = new LoopbackDiscoveryHub();
  const peers: InProcessPeer[] = [];
  const stop = async () => {
    await Promise.all(peers.map((p) => p.core.close()));
    if (ownsRoot && !options.keepData)
      rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5 });
  };
  try {
    for (let index = 0; index < options.count; index++) {
      const core = await Core.start({
        dataDir: join(dataRoot, simProfile(index)),
        profile: simProfile(index),
        appVersion: 'sim',
        keyProtector: new InsecureTestKeyProtector(),
        logger: options.logger ?? silentLogger,
        defaultDisplayName: async () => simName(index),
        ...(options.clock && { clock: options.clock }),
      });
      peers.push({ index, core });
    }
  } catch (err) {
    await stop();
    throw err;
  }
  return { dataRoot, hub, peers, stop };
}
