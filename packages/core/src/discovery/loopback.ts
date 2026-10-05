import { BEACON_PORT } from '@officemesh/protocol';
import type { DatagramSource, DiscoveryDriver } from '../interfaces.ts';

type Listener = (datagram: Uint8Array, from: DatagramSource) => void;

/**
 * In-memory stand-in for a LAN segment. Every driver on the hub receives every datagram,
 * including its own (as with IP multicast loopback). Tests can partition the segment.
 */
export class LoopbackDiscoveryHub {
  private readonly members = new Map<string, Set<Listener>>();
  /** Return false to drop a datagram between two addresses. */
  canDeliver: (from: string, to: string) => boolean = () => true;

  createDriver(address: string): DiscoveryDriver {
    if (this.members.has(address)) throw new Error(`address ${address} is already on the hub`);
    const listeners = new Set<Listener>();
    this.members.set(address, listeners);
    let closed = false;
    return {
      send: (datagram) => {
        if (closed) return;
        const copy = Uint8Array.from(datagram);
        for (const [to, targets] of this.members) {
          if (!this.canDeliver(address, to)) continue;
          // Deliver asynchronously, like a real socket.
          setImmediate(() => {
            for (const l of targets) l(copy, { address, port: BEACON_PORT });
          });
        }
      },
      onDatagram: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close: async () => {
        closed = true;
        listeners.clear();
        this.members.delete(address);
      },
    };
  }

  get size(): number {
    return this.members.size;
  }
}
