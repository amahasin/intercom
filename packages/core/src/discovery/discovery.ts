import type { KeyObject } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { BEACON_INTERVAL_MS, type BeaconBody, type SignedBeacon } from '@officemesh/protocol';
import type { Clock, DatagramSource, DiscoveryDriver, Logger, TimerHandle } from '../interfaces.ts';
import { BeaconVerifier, encodeBeacon, type BeaconSigner } from './beacon.ts';

export interface DiscoveryStats {
  received: number;
  accepted: number;
  rejected: number;
  /** Wall time spent handling received datagrams (for the CPU budget). */
  handlerMs: number;
}

export interface DiscoveryServiceOptions {
  driver: DiscoveryDriver;
  signer: BeaconSigner;
  clock: Clock;
  logger: Logger;
  /** Current values for the next beacon. */
  fields: () => Pick<BeaconBody, 'port' | 'presence' | 'inCall' | 'profileVer'>;
  onBeacon: (
    beacon: SignedBeacon,
    spki: Buffer,
    publicKey: KeyObject,
    from: DatagramSource,
  ) => void;
  onClockSkew: (userId: string) => void;
}

/** Sends a signed beacon every 5 s (and at once on change) and verifies those received. */
export class DiscoveryService {
  private readonly o: DiscoveryServiceOptions;
  private readonly verifier = new BeaconVerifier();
  private timer: TimerHandle | undefined;
  private unsubscribe: Array<() => void> = [];
  private stopped = false;
  readonly stats: DiscoveryStats = { received: 0, accepted: 0, rejected: 0, handlerMs: 0 };

  constructor(options: DiscoveryServiceOptions) {
    this.o = options;
  }

  start(): void {
    this.unsubscribe.push(this.o.driver.onDatagram((d, from) => this.receive(d, from)));
    const offNet = this.o.driver.onNetworkChange?.(() => this.announce());
    if (offNet) this.unsubscribe.push(offNet);
    this.timer = this.o.clock.setInterval(() => this.announce(), BEACON_INTERVAL_MS);
    this.announce();
  }

  /** Send an `alive` beacon now (start-up, presence or profile change, network change, resume). */
  announce(): void {
    this.send('alive');
  }

  /** Tell peers we are leaving (quit, sleep) so they show us Offline at once. */
  sayBye(): void {
    this.send('bye');
  }

  private send(kind: 'alive' | 'bye'): void {
    if (this.stopped) return;
    try {
      this.o.driver.send(
        encodeBeacon(this.o.signer, { kind, ts: this.o.clock.now(), ...this.o.fields() }),
      );
    } catch (err) {
      this.o.logger.warn('beacon send failed', { err: String(err) });
    }
  }

  private receive(datagram: Uint8Array, from: DatagramSource): void {
    const started = performance.now();
    this.stats.received++;
    const verdict = this.verifier.verify(datagram, this.o.clock.now());
    if (!verdict.ok) {
      this.stats.rejected++;
      if (
        verdict.reason === 'clock-skew' &&
        verdict.userId &&
        verdict.userId !== this.o.signer.userId
      ) {
        this.o.onClockSkew(verdict.userId);
      }
    } else if (verdict.beacon.userId !== this.o.signer.userId) {
      this.stats.accepted++;
      this.o.onBeacon(verdict.beacon, verdict.spki, verdict.publicKey, from);
    }
    this.stats.handlerMs += performance.now() - started;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.sayBye();
    this.stopped = true;
    if (this.timer) this.o.clock.clearInterval(this.timer);
    for (const off of this.unsubscribe) off();
    await this.o.driver.close();
  }
}
