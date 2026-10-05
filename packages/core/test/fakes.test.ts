import { describe, expect, it } from 'vitest';
import { FakeClock, LoopbackDiscoveryHub } from '../src/testing/index.ts';

describe('FakeClock', () => {
  it('fires timeouts and intervals in time order only when advanced', () => {
    const clock = new FakeClock(1_000);
    const log: string[] = [];
    clock.setTimeout(() => log.push(`t500@${clock.now()}`), 500);
    const iv = clock.setInterval(() => log.push(`i300@${clock.now()}`), 300);
    const cancelled = clock.setTimeout(() => log.push('never'), 100);
    clock.clearTimeout(cancelled);
    expect(log).toEqual([]);
    clock.advance(1_000);
    expect(log).toEqual(['i300@1300', 't500@1500', 'i300@1600', 'i300@1900']);
    expect(clock.now()).toBe(2_000);
    clock.clearInterval(iv);
    clock.advance(10_000);
    expect(log).toHaveLength(4);
    expect(clock.pendingTimers).toBe(0);
  });
});

describe('LoopbackDiscoveryHub', () => {
  it('delivers to every driver including the sender, and honours partitions', async () => {
    const hub = new LoopbackDiscoveryHub();
    const a = hub.createDriver('10.0.0.1');
    const b = hub.createDriver('10.0.0.2');
    const c = hub.createDriver('10.0.0.3');
    const got: Record<string, string[]> = { a: [], b: [], c: [] };
    a.onDatagram((d, from) => got.a!.push(`${new TextDecoder().decode(d)}<${from.address}`));
    b.onDatagram((d, from) => got.b!.push(`${new TextDecoder().decode(d)}<${from.address}`));
    c.onDatagram((d, from) => got.c!.push(`${new TextDecoder().decode(d)}<${from.address}`));

    hub.canDeliver = (_from, to) => to !== '10.0.0.3';
    a.send(new TextEncoder().encode('hi'));
    await new Promise((r) => setImmediate(r));
    expect(got).toEqual({ a: ['hi<10.0.0.1'], b: ['hi<10.0.0.1'], c: [] });

    await c.close();
    expect(hub.size).toBe(2);
    expect(() => hub.createDriver('10.0.0.1')).toThrow();
  });
});
