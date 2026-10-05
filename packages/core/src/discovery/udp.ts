import dgram from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { BEACON_MULTICAST_GROUP, BEACON_PORT } from '@officemesh/protocol';
import type { DatagramSource, DiscoveryDriver, Logger } from '../interfaces.ts';

export interface Iface {
  address: string;
  broadcast: string;
}

export const LOOPBACK_ONLY = (): Iface[] => [
  { address: '127.0.0.1', broadcast: '127.255.255.255' },
];

/** Usable IPv4 interfaces, or loopback alone when the PC has no network. */
export function ipv4Interfaces(): Iface[] {
  const out: Iface[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      const addr = info.address.split('.').map(Number);
      const mask = info.netmask.split('.').map(Number);
      const broadcast = addr.map((b, i) => (b | (~mask[i]! & 0xff)) & 0xff).join('.');
      out.push({ address: info.address, broadcast });
    }
  }
  if (out.length === 0) out.push({ address: '127.0.0.1', broadcast: '127.255.255.255' });
  return out.sort((a, b) => a.address.localeCompare(b.address));
}

export interface UdpDiscoveryOptions {
  port?: number;
  group?: string;
  logger: Logger;
  /** How often to look for interface changes. */
  interfacePollMs?: number;
  /** Override interface selection (tests pin discovery to loopback). */
  interfaces?: () => Iface[];
}

/**
 * Beacons over UDP multicast (TTL 1) with subnet broadcast as a fallback, on every active
 * IPv4 interface. One receive socket joins the group on each interface; one send socket
 * per interface pins the outgoing interface.
 */
export class UdpDiscoveryDriver implements DiscoveryDriver {
  private readonly port: number;
  private readonly group: string;
  private readonly logger: Logger;
  private readonly recv: dgram.Socket;
  private readonly senders = new Map<string, { socket: dgram.Socket; iface: Iface }>();
  private readonly listeners = new Set<(d: Uint8Array, from: DatagramSource) => void>();
  private readonly changeListeners = new Set<() => void>();
  private joined = new Set<string>();
  private readonly listInterfaces: () => Iface[];
  private poll: NodeJS.Timeout | undefined;
  private closed = false;
  /** Sends handed to the OS but not yet completed; close waits for them (the quit `bye`). */
  private inflight = 0;
  private drained: (() => void) | undefined;

  private constructor(options: UdpDiscoveryOptions) {
    this.port = options.port ?? BEACON_PORT;
    this.group = options.group ?? BEACON_MULTICAST_GROUP;
    this.logger = options.logger;
    this.listInterfaces = options.interfaces ?? ipv4Interfaces;
    this.recv = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  }

  static async open(options: UdpDiscoveryOptions): Promise<UdpDiscoveryDriver> {
    const driver = new UdpDiscoveryDriver(options);
    await driver.start(options.interfacePollMs ?? 5_000);
    return driver;
  }

  private async start(pollMs: number): Promise<void> {
    this.recv.on('message', (msg, rinfo) => {
      const from = { address: rinfo.address, port: rinfo.port };
      for (const l of this.listeners) l(msg, from);
    });
    this.recv.on('error', (err) =>
      this.logger.warn('discovery socket error', { err: err.message }),
    );
    await new Promise<void>((resolve, reject) => {
      this.recv.once('error', reject);
      this.recv.bind({ port: this.port, address: '0.0.0.0', exclusive: false }, () => {
        this.recv.off('error', reject);
        resolve();
      });
    });
    await this.refresh();
    this.poll = setInterval(() => void this.refresh(), pollMs);
    this.poll.unref();
  }

  /** Re-read interfaces; join and open senders for new ones, drop gone ones. */
  private async refresh(): Promise<void> {
    if (this.closed) return;
    const ifaces = this.listInterfaces();
    const wanted = new Set(ifaces.map((i) => i.address));
    let changed = false;

    for (const [address, sender] of this.senders) {
      if (wanted.has(address)) continue;
      sender.socket.close();
      this.senders.delete(address);
      changed = true;
    }
    for (const address of this.joined) {
      if (wanted.has(address)) continue;
      try {
        this.recv.dropMembership(this.group, address);
      } catch {
        // The interface is already gone.
      }
      this.joined.delete(address);
    }
    for (const iface of ifaces) {
      if (!this.joined.has(iface.address)) {
        try {
          this.recv.addMembership(this.group, iface.address);
          this.joined.add(iface.address);
        } catch (err) {
          this.logger.warn('could not join multicast group', {
            iface: iface.address,
            err: String(err),
          });
        }
      }
      if (!this.senders.has(iface.address)) {
        try {
          this.senders.set(iface.address, { socket: await this.openSender(iface), iface });
          changed = true;
        } catch (err) {
          this.logger.warn('could not open beacon sender', {
            iface: iface.address,
            err: String(err),
          });
        }
      }
    }
    if (changed && this.joined.size + this.senders.size > 0) {
      for (const l of this.changeListeners) l();
    }
  }

  private openSender(iface: Iface): Promise<dgram.Socket> {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      socket.once('error', reject);
      socket.bind({ address: iface.address, port: 0 }, () => {
        socket.off('error', reject);
        socket.on('error', (err) =>
          this.logger.debug('beacon send error', { iface: iface.address, err: err.message }),
        );
        socket.setBroadcast(true);
        socket.setMulticastTTL(1);
        socket.setMulticastLoopback(true);
        socket.setMulticastInterface(iface.address);
        resolve(socket);
      });
    });
  }

  send(datagram: Uint8Array): void {
    if (this.closed) return;
    const done = () => {
      if (--this.inflight === 0) this.drained?.();
    };
    for (const { socket, iface } of this.senders.values()) {
      this.inflight++;
      socket.send(datagram, this.port, this.group, done);
      // A /32 interface (typical for VPNs) has no subnet to broadcast to.
      if (iface.broadcast !== iface.address) {
        this.inflight++;
        socket.send(datagram, this.port, iface.broadcast, done);
      }
    }
  }

  onDatagram(listener: (datagram: Uint8Array, from: DatagramSource) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onNetworkChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  get interfaceCount(): number {
    return this.senders.size;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.poll);
    // Closing a socket cancels queued sends: let the final `bye` leave first.
    if (this.inflight > 0) {
      await new Promise<void>((resolve) => {
        this.drained = resolve;
        setTimeout(resolve, 500).unref();
      });
    }
    this.listeners.clear();
    this.changeListeners.clear();
    const closing = [...this.senders.values()].map(
      ({ socket }) => new Promise<void>((r) => socket.close(() => r())),
    );
    closing.push(new Promise<void>((r) => this.recv.close(() => r())));
    this.senders.clear();
    await Promise.all(closing);
  }
}
