import type { ManualPresenceState } from '@officemesh/protocol';
import type { IdentityView } from '@officemesh/protocol/ipc';

export type PeerToSim =
  | { type: 'ready'; pid: number; identity: IdentityView }
  | { type: 'error'; message: string }
  | { type: 'done'; id: number; result?: unknown; error?: string };

/** Scripted actions for soak and load runs. */
export type PeerAction =
  | { op: 'dm'; userId: string; text: string }
  | { op: 'group'; members: string[]; title: string }
  | { op: 'post'; convId: string; text: string }
  | { op: 'presence'; state: ManualPresenceState }
  | { op: 'stats' };

export type SimToPeer = { type: 'stop' } | ({ type: 'act'; id: number } & PeerAction);
