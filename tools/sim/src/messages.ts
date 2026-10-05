import type { IdentityView } from '@officemesh/protocol/ipc';

export type PeerToSim =
  { type: 'ready'; pid: number; identity: IdentityView } | { type: 'error'; message: string };

export type SimToPeer = { type: 'stop' };
