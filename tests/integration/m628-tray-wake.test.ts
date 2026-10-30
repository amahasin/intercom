/**
 * M6.28: the tray icon and its menu (what they hold, how the pictures are drawn), and Wake on LAN:
 * the packet, where it is sent, which hardware addresses a PC reports, and the core's part.
 */
import { createSocket } from 'node:dgram';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Core, silentLogger, type WakeRoute } from '@officemesh/core';
import { FakeClock, InsecureTestKeyProtector } from '@officemesh/core/testing';
import { MachineInfo } from '@officemesh/protocol';
import { MacAddress } from '@officemesh/protocol/ipc';
import { startInProcessPeers, type InProcessSim } from '@officemesh/sim';
import { describeMacs } from '../../packages/core/src/peers/machine.ts';
import {
  magicPacket,
  normalizeMac,
  sendWake,
  udpWakeSender,
  wakeRoutes,
} from '../../packages/core/src/peers/wake.ts';
import { allKnowEachOther, until } from './helpers.ts';

// The main process's own code is loaded by path: it has its own build settings.
const here = dirname(fileURLToPath(import.meta.url));
const load = async <T>(file: string): Promise<T> =>
  (await import(pathToFileURL(join(here, '../../apps/desktop/main/src', file)).href)) as T;
interface Model {
  trayModel(
    who: { name: string; presence: string; manual: string; inCall: boolean } | undefined,
    unread: number,
  ): Item[];
  trayTooltip(
    who: { name: string; presence: string; manual: string; inCall: boolean } | undefined,
    unread: number,
  ): string;
}
interface Item {
  id: string;
  label: string;
  enabled?: boolean;
  checked?: boolean;
  dot?: string;
  separator?: boolean;
  children?: Item[];
}
interface Raster {
  width: number;
  height: number;
  bgra: Buffer;
}
interface Icons {
  presenceIcon(state: string, size: number): Raster;
  trayIcon(base: Raster, state: string | undefined, unread: boolean): Raster;
}
const { trayModel, trayTooltip } = await load<Model>('tray-model.ts');
const { presenceIcon, trayIcon } = await load<Icons>('tray-icons.ts');

const sims: InProcessSim[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const s of sims.splice(0)) await s.stop();
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe('M6.28 the tray menu', () => {
  const me = { name: 'Sam Rivera', presence: 'available', manual: 'available', inCall: false };
  const flat = (items: Item[]): Item[] => items.flatMap((i) => [i, ...flat(i.children ?? [])]);

  it('has who this is, the status to pick, Open and Quit', () => {
    const items = trayModel(me, 0);
    expect(items.filter((i) => !i.separator).map((i) => i.label)).toEqual([
      'Sam Rivera',
      'Available',
      'Open InterCom',
      'Quit InterCom',
    ]);
    const status = items.find((i) => i.id === 'status')!;
    expect(status.dot).toBe('available');
    expect(status.children!.filter((c) => !c.separator).map((c) => c.label)).toEqual([
      'Available',
      'Busy',
      'Do not disturb',
      'Be right back',
      'Away',
      'Reset status',
    ]);
  });

  it('checks the status the user picked, not the one shown while away', () => {
    const away = trayModel({ ...me, presence: 'away', manual: 'busy' }, 0);
    const status = away.find((i) => i.id === 'status')!;
    expect(status.label).toBe('Away');
    expect(status.children!.filter((c) => c.checked).map((c) => c.id)).toEqual(['presence:busy']);
  });

  it('says "In a call" with the busy dot while in a call', () => {
    const status = trayModel({ ...me, inCall: true }, 0).find((i) => i.id === 'status')!;
    expect(status.label).toBe('In a call');
    expect(status.dot).toBe('busy');
  });

  it('lists what is unread, and only then', () => {
    expect(flat(trayModel(me, 0)).some((i) => i.id === 'unread')).toBe(false);
    expect(trayModel(me, 1).find((i) => i.id === 'unread')?.label).toBe('1 unread message');
    expect(trayModel(me, 12).find((i) => i.id === 'unread')?.label).toBe('12 unread messages');
  });

  it('is usable before the core has said who this is', () => {
    const items = trayModel(undefined, 0);
    expect(items[0]!.label).toBe('InterCom');
    expect(items.find((i) => i.id === 'status')).toMatchObject({
      label: 'Starting…',
      enabled: false,
    });
  });

  it('has a tooltip with who, status and unread, within what Windows shows', () => {
    expect(trayTooltip(undefined, 0)).toBe('InterCom');
    expect(trayTooltip({ ...me, presence: 'dnd' }, 3)).toBe(
      'InterCom: Sam Rivera, Do not disturb · 3 unread',
    );
    expect(trayTooltip({ ...me, name: 'N'.repeat(300) }, 0).length).toBeLessThanOrEqual(127);
  });
});

describe('M6.28 the tray pictures', () => {
  const pixel = (r: Raster, x: number, y: number) => {
    const o = (y * r.width + x) * 4;
    return { b: r.bgra[o]!, g: r.bgra[o + 1]!, r: r.bgra[o + 2]!, a: r.bgra[o + 3]! };
  };
  const opaque = (c: { a: number }) => c.a === 255;

  it('draws a dot for each status in its colour, round, with nothing outside it', () => {
    for (const [state, colour] of [
      ['busy', { r: 0xc4, g: 0x2b, b: 0x1c }],
      ['brb', { r: 0xea, g: 0xa3, b: 0x00 }],
    ] as const) {
      const r = presenceIcon(state, 32);
      // Busy is a plain disc and brb has hands: look off-centre, where both are the dot's colour.
      expect(pixel(r, 6, 16)).toEqual({ ...colour, a: 255 });
      // The corners are empty.
      expect(pixel(r, 0, 0).a).toBe(0);
      expect(pixel(r, 31, 31).a).toBe(0);
    }
  });

  it('marks available with a white tick and do not disturb with a white bar', () => {
    const tick = presenceIcon('available', 32);
    expect(pixel(tick, 16, 16)).not.toMatchObject({ r: 0x10, g: 0x7c, b: 0x10 });
    const bar = presenceIcon('dnd', 32);
    expect(pixel(bar, 16, 16)).toMatchObject({ r: 255, g: 255, b: 255, a: 255 });
    // Off the bar it is red.
    expect(pixel(bar, 16, 8)).toMatchObject({ r: 0xc4, g: 0x2b, b: 0x1c });
  });

  const base = (size: number): Raster => {
    const bgra = Buffer.alloc(size * size * 4, 0);
    for (let i = 0; i < size * size; i++) {
      bgra[i * 4] = 0xc8;
      bgra[i * 4 + 1] = 0x8a;
      bgra[i * 4 + 2] = 0x2b;
      bgra[i * 4 + 3] = 255;
    }
    return { width: size, height: size, bgra };
  };

  it('puts the status dot at the lower right of the icon and leaves the rest as it was', () => {
    const plain = base(32);
    const withDot = trayIcon(plain, 'busy', false);
    expect(withDot.width).toBe(32);
    // The upper left is the icon, untouched; the lower right is the dot.
    expect(pixel(withDot, 3, 3)).toEqual(pixel(plain, 3, 3));
    const corner = pixel(withDot, 24, 24);
    expect(corner).toMatchObject({ r: 0xc4, g: 0x2b, b: 0x1c });
    // The base is not changed in place (it is reused for every status).
    expect(pixel(plain, 24, 24)).toMatchObject({ r: 0x2b, g: 0x8a, b: 0xc8 });
  });

  it('adds a red dot at the upper right when something is unread, and not otherwise', () => {
    const read = trayIcon(base(32), 'available', false);
    const unread = trayIcon(base(32), 'available', true);
    expect(pixel(read, 24, 7)).toMatchObject({ r: 0x2b, g: 0x8a, b: 0xc8 });
    expect(pixel(unread, 24, 7)).toMatchObject({ r: 0xe8, g: 0x11, b: 0x23 });
    expect(opaque(pixel(unread, 24, 7))).toBe(true);
  });

  it('works at every size Windows uses', () => {
    for (const size of [16, 24, 32, 48]) {
      const r = trayIcon(base(size), 'dnd', true);
      expect(r.bgra.length).toBe(size * size * 4);
      expect(presenceIcon('away', size).bgra.length).toBe(size * size * 4);
    }
  });
});

describe('M6.28 the wake-up packet', () => {
  it('reads a hardware address however it is written', () => {
    expect(normalizeMac('aa-bb-cc-dd-ee-ff')).toBe('AA:BB:CC:DD:EE:FF');
    expect(normalizeMac('AABBCCDDEEFF')).toBe('AA:BB:CC:DD:EE:FF');
    expect(normalizeMac(' 0a:1b:2c:3d:4e:5f ')).toBe('0A:1B:2C:3D:4E:5F');
    expect(normalizeMac('AA:BB:CC:DD:EE')).toBeUndefined();
    expect(normalizeMac('AA:BB:CC:DD:EE:GG')).toBeUndefined();
    expect(normalizeMac('')).toBeUndefined();
    expect(MacAddress.safeParse('aa-bb-cc-dd-ee-ff').success).toBe(true);
    expect(MacAddress.safeParse('aabbccddeeff').success).toBe(true);
    expect(MacAddress.safeParse('aa:bb-cc:dd-ee:ff').success).toBe(false);
    expect(MacAddress.safeParse('not an address').success).toBe(false);
  });

  it('is six 0xFF and the address sixteen times: 102 bytes', () => {
    const packet = magicPacket('AA:BB:CC:DD:EE:FF');
    expect(packet.length).toBe(102);
    expect(packet.subarray(0, 6)).toEqual(Buffer.alloc(6, 0xff));
    for (let i = 0; i < 16; i++)
      expect(packet.subarray(6 + i * 6, 12 + i * 6).toString('hex')).toBe('aabbccddeeff');
    expect(() => magicPacket('AA:BB')).toThrow();
  });

  it('goes to each network’s broadcast address and the limited broadcast, on ports 9 and 7', () => {
    const routes = wakeRoutes([{ address: '192.168.10.23', netmask: '255.255.255.0' }]);
    expect(routes).toEqual([
      { from: '192.168.10.23', to: '192.168.10.255', port: 9 },
      { from: '192.168.10.23', to: '192.168.10.255', port: 7 },
      { from: '192.168.10.23', to: '255.255.255.255', port: 9 },
      { from: '192.168.10.23', to: '255.255.255.255', port: 7 },
    ]);
    // A wider network has a wider broadcast.
    expect(
      wakeRoutes([{ address: '10.1.2.3', netmask: '255.255.0.0' }], undefined, [9]).map(
        (r) => r.to,
      ),
    ).toEqual(['10.1.255.255', '255.255.255.255']);
  });

  it('on every network this PC is on, and for a colleague on another subnet, the one around them', () => {
    const two = wakeRoutes(
      [
        { address: '192.168.10.23', netmask: '255.255.255.0' },
        { address: '172.16.0.4', netmask: '255.255.255.0' },
      ],
      '192.168.10.100',
      [9],
    );
    expect(two.map((r) => `${r.from}>${r.to}`)).toEqual([
      '192.168.10.23>192.168.10.255',
      '192.168.10.23>255.255.255.255',
      '172.16.0.4>172.16.0.255',
      '172.16.0.4>255.255.255.255',
    ]);
    const far = wakeRoutes(
      [{ address: '192.168.10.23', netmask: '255.255.255.0' }],
      '10.9.8.7',
      [9],
    );
    expect(far.map((r) => r.to)).toEqual([
      '192.168.10.255',
      '255.255.255.255',
      '10.9.8.255',
      '10.9.8.7',
    ]);
    expect(wakeRoutes([], '10.9.8.7')).toEqual([]);
  });

  it('really arrives as a datagram of those bytes', async () => {
    const listener = createSocket('udp4');
    const got = new Promise<Buffer>((resolve) => listener.once('message', (m) => resolve(m)));
    await new Promise<void>((resolve) => listener.bind(0, '127.0.0.1', resolve));
    const port = listener.address().port;
    try {
      const route: WakeRoute = { from: '127.0.0.1', to: '127.0.0.1', port };
      await udpWakeSender(magicPacket('01:23:45:67:89:AB'), route);
      expect(await got).toEqual(magicPacket('01:23:45:67:89:AB'));
    } finally {
      listener.close();
    }
  });

  it('counts what went out, skips a network that fails, and sends every address', async () => {
    const seen: string[] = [];
    const sent = await sendWake(
      ['AA:BB:CC:DD:EE:01', 'AA:BB:CC:DD:EE:02'],
      [
        { from: 'a', to: '1', port: 9 },
        { from: 'b', to: '2', port: 9 },
      ],
      async (packet, route) => {
        if (route.from === 'b') throw new Error('adapter is down');
        seen.push(`${packet.subarray(6, 12).toString('hex')}@${route.to}`);
      },
    );
    expect(sent).toBe(2);
    expect(seen).toEqual(['aabbccddee01@1', 'aabbccddee02@1']);
    expect(await sendWake(['AA:BB:CC:DD:EE:01'], [], async () => {})).toBe(0);
  });
});

describe('M6.28 the hardware addresses a PC tells colleagues', () => {
  const nic = (mac: string, address = '192.168.1.5', internal = false) => ({
    address,
    netmask: '255.255.255.0',
    family: 'IPv4' as const,
    mac,
    internal,
    cidr: `${address}/24`,
  });
  it('lists wired cards first, once each, without virtual adapters, loopback or unconnected cards', () => {
    expect(
      describeMacs({
        'Wi-Fi': [nic('aa:00:00:00:00:02')],
        Ethernet: [nic('aa:00:00:00:00:01')],
        'vEthernet (Default Switch)': [nic('aa:00:00:00:00:03', '172.20.0.1')],
        'VMware Network Adapter VMnet1': [nic('aa:00:00:00:00:04', '192.168.99.1')],
        'Bluetooth Network Connection': [nic('aa:00:00:00:00:05', '169.254.1.1')],
        'Loopback Pseudo-Interface 1': [nic('00:00:00:00:00:00', '127.0.0.1', true)],
        'Ethernet 2': [nic('aa:00:00:00:00:01')],
        'Ethernet 3': [nic('aa:00:00:00:00:06', '169.254.9.9')],
      }),
    ).toEqual(['AA:00:00:00:00:01', 'AA:00:00:00:00:02']);
  });

  it('is at most four, and nothing for a PC without a network', () => {
    const many = Object.fromEntries(
      Array.from({ length: 7 }, (_, i) => [`Ethernet ${i}`, [nic(`aa:00:00:00:00:0${i}`)]]),
    );
    expect(describeMacs(many)).toHaveLength(4);
    expect(describeMacs({})).toEqual([]);
  });

  it('is part of what a PC says about itself, and an older one without it still parses', () => {
    const base = { host: 'pc', os: 'Windows', arch: 'x64' };
    expect(MachineInfo.safeParse({ ...base, macs: ['AA:BB:CC:DD:EE:FF'] }).success).toBe(true);
    expect(MachineInfo.safeParse(base).success).toBe(true);
    expect(MachineInfo.safeParse({ ...base, macs: ['not a mac'] }).success).toBe(false);
  });
});

describe('M6.28 waking a colleague from the core', () => {
  async function start(sender: (packet: Buffer, route: WakeRoute) => Promise<void>) {
    const root = mkdtempSync(join(tmpdir(), 'intercom-wake-'));
    const core = await Core.start({
      dataDir: join(root, 'alice'),
      profile: 'alice',
      appVersion: '0.18.5',
      keyProtector: new InsecureTestKeyProtector(),
      logger: silentLogger,
      defaultDisplayName: async () => 'Alice',
      host: { fixFirewall: async () => {}, openNetworkSettings: () => {}, wake: sender },
    });
    cleanups.push(async () => {
      await core.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    });
    return core;
  }
  const COLLEAGUE = 'b'.repeat(32);

  it('needs an address; a typed one is kept and used, and can be forgotten', async () => {
    const out: string[] = [];
    const core = await start(async (packet) => {
      out.push(packet.subarray(6, 12).toString('hex'));
    });
    expect(core.wakeInfo(COLLEAGUE)).toEqual({ macs: [] });
    await expect(core.wakePeer(COLLEAGUE)).rejects.toThrow(/no hardware address/i);
    await expect(core.wakePeer(COLLEAGUE, 'garbage')).rejects.toThrow(/hardware address/i);

    const first = await core.wakePeer(COLLEAGUE, 'aa-bb-cc-dd-ee-ff');
    expect(first.sent).toBeGreaterThan(0);
    expect(new Set(out)).toEqual(new Set(['aabbccddeeff']));
    expect(core.wakeInfo(COLLEAGUE)).toEqual({ macs: [], custom: 'AA:BB:CC:DD:EE:FF' });

    // Kept: the next wake-up needs nothing typed.
    out.length = 0;
    await core.wakePeer(COLLEAGUE);
    expect(new Set(out)).toEqual(new Set(['aabbccddeeff']));

    // Forgotten: back to needing one.
    await expect(core.wakePeer(COLLEAGUE, '')).rejects.toThrow(/no hardware address/i);
    expect(core.wakeInfo(COLLEAGUE)).toEqual({ macs: [] });
  });

  it('says so when no network could send it', async () => {
    const core = await start(async () => {
      throw new Error('adapter is down');
    });
    await expect(core.wakePeer(COLLEAGUE, 'aa:bb:cc:dd:ee:ff')).rejects.toThrow(
      /could not be sent/,
    );
  });

  it('uses the addresses a colleague’s PC reported', async () => {
    const clock = new FakeClock();
    const sim = await startInProcessPeers({ count: 2, clock });
    sims.push(sim);
    const [a, b] = [0, 1].map((i) => sim.peers[i]!.core) as [Core, Core];
    await until(clock, () => allKnowEachOther([a, b]), 20_000);
    await until(
      clock,
      () => a.people().find((p) => p.userId === b.userId)?.machine !== undefined,
      20_000,
    );
    const seen = a.people().find((p) => p.userId === b.userId)!.machine!;
    // The two "PCs" are this one: its cards are what is reported (none, on a PC without a network).
    expect(a.wakeInfo(b.userId).macs).toEqual(seen.macs ?? []);
  });

  it('hands the tray who this is and how they show, at start and at each change', async () => {
    const told: Array<{ name: string; presence: string; manual: string; inCall: boolean }> = [];
    const root = mkdtempSync(join(tmpdir(), 'intercom-tray-'));
    const core = await Core.start({
      dataDir: join(root, 'alice'),
      profile: 'alice',
      appVersion: '0.18.5',
      keyProtector: new InsecureTestKeyProtector(),
      logger: silentLogger,
      defaultDisplayName: async () => 'Alice',
      host: {
        fixFirewall: async () => {},
        openNetworkSettings: () => {},
        tray: (state) => told.push(state),
      },
    });
    cleanups.push(async () => {
      await core.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    });
    expect(told.at(-1)).toMatchObject({ name: 'Alice', presence: 'available', inCall: false });
    core.updateProfile({ displayName: 'Alice Smith' });
    expect(told.at(-1)).toMatchObject({ name: 'Alice Smith' });
  });
});
