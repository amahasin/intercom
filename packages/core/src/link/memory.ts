import {
  DEFAULT_LINK_PORT,
  MAX_BINARY_FRAME_BYTES,
  MAX_TEXT_FRAME_BYTES,
} from '@officemesh/protocol';
import type { DialTarget, PeerChannel, Transport } from '../interfaces.ts';
import { BaseChannel } from './channel.ts';

interface Endpoint {
  address: string;
  userId: string;
  spki: Buffer;
  onInbound: (channel: PeerChannel) => void;
}

class MemoryChannel extends BaseChannel {
  other: MemoryChannel | undefined;
  readonly localAddress: string;
  readonly remoteAddress: string;
  private readonly network: MemoryNetwork;

  constructor(
    network: MemoryNetwork,
    local: string,
    remote: string,
    remoteUserId: string,
    remoteSpki: Buffer,
  ) {
    super(remoteUserId, remoteSpki);
    this.network = network;
    this.localAddress = local;
    this.remoteAddress = remote;
  }

  send(data: string | Uint8Array): void {
    if (this.isClosed) return;
    const size = typeof data === 'string' ? Buffer.byteLength(data) : data.length;
    if (size > (typeof data === 'string' ? MAX_TEXT_FRAME_BYTES : MAX_BINARY_FRAME_BYTES)) {
      this.close('frame too large');
      return;
    }
    // A pulled cable loses traffic silently; the link only notices through its keepalive.
    if (!this.network.canConnect(this.localAddress, this.remoteAddress)) return;
    const copy = typeof data === 'string' ? data : Uint8Array.from(data);
    const peer = this.other;
    setImmediate(() => peer?.receive(copy));
  }

  receive(data: string | Uint8Array): void {
    this.deliver(data);
  }

  close(reason = 'closed'): void {
    if (this.isClosed) return;
    this.closed(reason);
    this.network.forget(this);
    const peer = this.other;
    setImmediate(() => peer?.closeFromRemote(reason));
  }

  closeFromRemote(reason: string): void {
    this.closed(reason);
    this.network.forget(this);
  }
}

/**
 * An in-memory LAN for multi-peer tests: authenticated channels with real async delivery,
 * plus partitions and cable pulls. Key checks against real certificates are tested on
 * the TLS transport.
 */
export class MemoryNetwork {
  private readonly endpoints = new Map<string, Endpoint>();
  private readonly channels = new Set<MemoryChannel>();
  /** Return false to refuse connections (and drop traffic) between two addresses. */
  canConnect: (a: string, b: string) => boolean = () => true;

  /** A transport for one peer at `address`. */
  transport(address: string, identity: { userId: string; spki: Buffer }): Transport {
    return {
      listen: async (onInbound) => {
        this.endpoints.set(`${address}:${DEFAULT_LINK_PORT}`, { address, ...identity, onInbound });
        return DEFAULT_LINK_PORT;
      },
      dial: async (target: DialTarget) => {
        await new Promise((r) => setImmediate(r));
        const remote = this.endpoints.get(`${target.address}:${target.port}`);
        if (!remote || !this.canConnect(address, remote.address))
          throw new Error('connection refused');
        if (remote.userId !== target.expectedUserId)
          throw new Error('peer presented the wrong key');
        const local = new MemoryChannel(this, address, remote.address, remote.userId, remote.spki);
        const inbound = new MemoryChannel(
          this,
          remote.address,
          address,
          identity.userId,
          identity.spki,
        );
        local.other = inbound;
        inbound.other = local;
        this.channels.add(local);
        this.channels.add(inbound);
        remote.onInbound(inbound);
        return local;
      },
      close: async () => {
        this.endpoints.delete(`${address}:${DEFAULT_LINK_PORT}`);
        for (const ch of [...this.channels]) {
          if (ch.localAddress === address) ch.close('transport closed');
        }
      },
    };
  }

  /** Sever every channel between two addresses, as when a cable is pulled. Nothing is sent. */
  sever(a: string, b: string): void {
    for (const ch of [...this.channels]) {
      if (
        (ch.localAddress === a && ch.remoteAddress === b) ||
        (ch.localAddress === b && ch.remoteAddress === a)
      ) {
        ch.closeFromRemote('severed');
      }
    }
  }

  /**
   * Sever every channel to or from an address without any goodbye (cable pull, power
   * loss). Pair with `canConnect` to keep new connections out until it is plugged back in.
   */
  pullPlug(address: string): void {
    for (const ch of [...this.channels]) {
      if (ch.localAddress === address || ch.remoteAddress === address)
        ch.closeFromRemote('severed');
    }
  }

  forget(channel: MemoryChannel): void {
    this.channels.delete(channel);
  }

  get openChannels(): number {
    return this.channels.size;
  }
}
