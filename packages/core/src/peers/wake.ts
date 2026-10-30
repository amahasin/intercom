import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';

/**
 * Wake on LAN: a "magic packet" (six bytes of 0xFF, then the target's hardware address sixteen
 * times) broadcast on the network. A PC that is off or asleep, whose network adapter is set to wake
 * on it (in the BIOS/UEFI and in the adapter's settings), starts when it sees its own address.
 * Nothing answers: there is no way to know it worked except the PC coming online.
 */

/** "aa-bb-cc-dd-ee-ff", "AABBCCDDEEFF" and so on as "AA:BB:CC:DD:EE:FF", or undefined if it is not one. */
export function normalizeMac(text: string): string | undefined {
  const hex = text.trim().replace(/[:-]/g, '');
  if (!/^[0-9A-Fa-f]{12}$/.test(hex)) return undefined;
  return hex.toUpperCase().replace(/(..)(?=.)/g, '$1:');
}

export function magicPacket(mac: string): Buffer {
  const hex = mac.replace(/[:-]/g, '');
  const address = Buffer.from(hex, 'hex');
  if (address.length !== 6) throw new Error('not a hardware address');
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => address)]);
}

/** Where a packet goes, and from which of this PC's addresses it is sent (which decides the network it leaves on). */
export interface WakeRoute {
  from: string;
  to: string;
  port: number;
}

/** The ports PCs listen on for it: 9 (discard) is the usual one, 7 (echo) the other. */
export const WAKE_PORTS = [9, 7] as const;

const ipToInt = (ip: string): number =>
  ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
const intToIp = (n: number): string =>
  [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

interface Adapter {
  address: string;
  netmask: string;
}

/** This PC's IPv4 networks (not loopback, not link-local). */
export function localNetworks(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): Adapter[] {
  const found: Adapter[] = [];
  for (const list of Object.values(interfaces))
    for (const a of list ?? [])
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))
        found.push({ address: a.address, netmask: a.netmask });
  return found;
}

/**
 * Where to send it. On each of this PC's networks: that network's broadcast address, and the
 * limited broadcast (255.255.255.255) from that address. For a colleague last seen at an address
 * on none of them (another subnet of the office), also the broadcast of the /24 around their
 * address and their address itself: a router that forwards directed broadcasts will pass the
 * first, and the second helps where the switch still knows the PC.
 */
export function wakeRoutes(
  networks: Adapter[],
  peerAddress?: string,
  ports: readonly number[] = WAKE_PORTS,
): WakeRoute[] {
  const routes: WakeRoute[] = [];
  const add = (from: string, to: string) => {
    for (const port of ports) routes.push({ from, to, port });
  };
  for (const n of networks) {
    const mask = ipToInt(n.netmask);
    add(n.address, intToIp(((ipToInt(n.address) & mask) | (~mask >>> 0)) >>> 0));
    add(n.address, '255.255.255.255');
  }
  if (peerAddress && /^\d+\.\d+\.\d+\.\d+$/.test(peerAddress) && networks.length > 0) {
    const sameNetwork = networks.some((n) => {
      const mask = ipToInt(n.netmask);
      return (ipToInt(n.address) & mask) === (ipToInt(peerAddress) & mask);
    });
    if (!sameNetwork) {
      const from = networks[0]!.address;
      add(from, `${peerAddress.split('.').slice(0, 3).join('.')}.255`);
      add(from, peerAddress);
    }
  }
  return routes;
}

/** Sends datagrams. The real one uses UDP; tests give their own. */
export type WakeSender = (packet: Buffer, route: WakeRoute) => Promise<void>;

export const udpWakeSender: WakeSender = (packet, route) =>
  new Promise((resolve, reject) => {
    const socket = createSocket('udp4');
    const done = (err?: Error) => {
      try {
        socket.close();
      } catch {
        // already closed
      }
      if (err) reject(err);
      else resolve();
    };
    socket.once('error', done);
    socket.bind({ address: route.from, port: 0 }, () => {
      try {
        socket.setBroadcast(true);
      } catch (err) {
        done(err as Error);
        return;
      }
      socket.send(packet, route.port, route.to, (err) => done(err ?? undefined));
    });
  });

/**
 * Send the wake-up for every address on every route. A route that fails (an adapter that is down) is
 * skipped; the number that went out is returned, 0 if none could.
 */
export async function sendWake(
  macs: readonly string[],
  routes: readonly WakeRoute[],
  send: WakeSender = udpWakeSender,
): Promise<number> {
  let sent = 0;
  for (const mac of macs) {
    const packet = magicPacket(mac);
    const results = await Promise.allSettled(routes.map((route) => send(packet, route)));
    sent += results.filter((r) => r.status === 'fulfilled').length;
  }
  return sent;
}
