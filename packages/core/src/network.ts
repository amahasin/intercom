import { SignedProfile, type PresenceState } from '@officemesh/protocol';
import { ProfileGetBody, ProfileDataBody } from '@officemesh/protocol';
import { DiscoveryService } from './discovery/discovery.ts';
import type { Identity } from './identity/identity.ts';
import { verifyProfile } from './identity/profile.ts';
import type { Clock, DiscoveryDriver, Logger, TimerHandle, Transport } from './interfaces.ts';
import { LinkManager } from './link/link-manager.ts';
import { PeerDirectory, type Peer } from './peers/directory.ts';
import type { PresenceService } from './peers/presence.ts';
import type { ConversationRepo } from './store/conversations.ts';
import { PeerRepo } from './store/peers.ts';
import type { Store } from './store/store.ts';
import { SyncEngine, type SyncEvents } from './sync/engine.ts';
import type { HybridClock } from './sync/hlc.ts';

const PROFILE_FETCH_CONCURRENCY = 4;
/**
 * A peer whose beacons arrive but whose link port cannot be reached (firewall) would
 * otherwise be re-dialed every 30 s just for its profile. Back off 30 s, 1, 2, 4... up to 10 min.
 */
const PROFILE_RETRY_BASE_MS = 30_000;
const PROFILE_RETRY_MAX_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 3_000;
const SWEEP_INTERVAL_MS = 1_000;

export interface PeerNetworkOptions {
  identity: Identity;
  store: Store;
  conversations: ConversationRepo;
  presence: PresenceService;
  hlc: HybridClock;
  clock: Clock;
  logger: Logger;
  appVersion: string;
  discovery: DiscoveryDriver;
  transport: Transport;
  syncEvents: SyncEvents;
  /** Called when a peer's online state flips (after the directory has updated). */
  onPeerOnlineChanged: (peer: Peer) => void;
  /** Called when network-status figures (such as clock-skewed peers) change. */
  onStatusChanged: () => void;
}

/**
 * Everything that talks to other PCs: beacons, the peer directory, links, profile fetch
 * and conversation sync. Peers are found with no configuration; links open on need.
 */
export class PeerNetwork {
  readonly directory: PeerDirectory;
  readonly links: LinkManager;
  readonly sync: SyncEngine;
  readonly discovery: DiscoveryService;
  private readonly o: PeerNetworkOptions;
  private readonly profileQueue = new Set<string>();
  private readonly profileInflight = new Set<string>();
  private readonly profileRetry = new Map<string, { failures: number; at: number }>();
  private readonly probing = new Set<string>();
  private readonly skewed = new Set<string>();
  private sweepTimer: TimerHandle | undefined;
  private stopped = false;

  constructor(options: PeerNetworkOptions) {
    this.o = options;
    const { identity, clock, logger } = options;
    this.directory = new PeerDirectory({
      repo: new PeerRepo(options.store.db),
      clock,
      logger,
      selfId: identity.userId,
      selfName: () => identity.profile.displayName,
    });
    this.links = new LinkManager({
      selfId: identity.userId,
      appVersion: options.appVersion,
      transport: options.transport,
      clock,
      logger,
    });
    // Learn the peer's key before any of its messages are handled.
    this.links.onLinkUp((userId) => this.onLinkUp(userId));
    this.links.on('profile.get', (_from, body) => {
      const { userId } = ProfileGetBody.parse(body);
      if (userId === identity.userId)
        return { type: 'profile.data', body: { profile: identity.profile } };
    });
    this.sync = new SyncEngine({
      repo: options.conversations,
      selfId: identity.userId,
      privateKey: identity.privateKey,
      publicKey: identity.publicKey,
      hlc: options.hlc,
      clock,
      logger,
      links: this.links,
      keyFor: (userId) => this.directory.get(userId)?.publicKey,
      isOnline: (userId) => this.directory.get(userId)?.online === true,
      wantLink: (userId) => this.dial(userId),
      events: options.syncEvents,
    });
    this.discovery = new DiscoveryService({
      driver: options.discovery,
      signer: identity,
      clock,
      logger,
      fields: () => ({
        port: this.links.port ?? 0,
        presence: options.presence.effective(),
        profileVer: identity.profile.version,
      }),
      onBeacon: (beacon, spki, _key, from) => {
        const outcome = this.directory.onBeacon(beacon, spki, from.address);
        if (beacon.kind === 'bye') {
          this.o.onPeerOnlineChanged(outcome.peer);
          return;
        }
        if (outcome.profileStale) this.queueProfile(beacon.userId);
        if (outcome.cameOnline) this.o.onPeerOnlineChanged(outcome.peer);
        if (this.sync.hasPendingFor(beacon.userId) && !this.links.isReady(beacon.userId))
          this.dial(beacon.userId);
        if (this.skewed.delete(beacon.userId)) this.o.onStatusChanged();
      },
      onClockSkew: (userId) => {
        if (this.skewed.has(userId)) return;
        logger.warn('peer clock differs by more than 30 s', { userId });
        this.skewed.add(userId);
        this.o.onStatusChanged();
      },
    });
  }

  async start(): Promise<void> {
    this.sync.loadPending(this.directory.all().map((p) => p.userId));
    await this.links.start();
    this.discovery.start();
    this.sweepTimer = this.o.clock.setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
  }

  get linkPort(): number | null {
    return this.links.port;
  }

  get clockSkewPeers(): number {
    return this.skewed.size;
  }

  /** Effective presence or own profile changed: tell everyone now. */
  announce(): void {
    this.discovery.announce();
  }

  /** Before sleep: say bye and drop links; peers show us Offline at once. */
  suspend(): void {
    this.discovery.sayBye();
    for (const userId of this.links.readyPeers()) this.links.disconnect(userId, 'sleeping');
  }

  resume(): void {
    this.discovery.announce();
  }

  /** Open a link to a peer if it is reachable; failures back off inside the link manager. */
  dial(userId: string): void {
    const peer = this.directory.get(userId);
    if (!peer?.online || !peer.address || !peer.port) return;
    void this.links.ensureLink(userId, peer.address, peer.port);
  }

  private onLinkUp(userId: string): void {
    const spki = this.links.remoteSpki(userId);
    if (!spki) return;
    const peer = this.directory.learn(userId, spki);
    // A link proves the peer is alive even if its beacons do not reach us.
    peer.lastLivenessAt = this.o.clock.now();
    if (!peer.online) {
      peer.online = true;
      if (peer.presence === 'offline') peer.presence = 'available' satisfies PresenceState;
      this.directory.markDirty(userId);
      this.o.onPeerOnlineChanged(peer);
    }
    if (!peer.profile || peer.advertisedProfileVersion > peer.profile.version) {
      this.profileRetry.delete(userId);
      this.queueProfile(userId);
    }
  }

  private queueProfile(userId: string): void {
    if (this.profileInflight.has(userId)) return;
    if ((this.profileRetry.get(userId)?.at ?? 0) > this.o.clock.now()) return;
    this.profileQueue.add(userId);
    this.pumpProfiles();
  }

  private pumpProfiles(): void {
    while (
      !this.stopped &&
      this.profileInflight.size < PROFILE_FETCH_CONCURRENCY &&
      this.profileQueue.size > 0
    ) {
      const userId = this.profileQueue.values().next().value!;
      this.profileQueue.delete(userId);
      this.profileInflight.add(userId);
      void this.fetchProfile(userId).finally(() => {
        this.profileInflight.delete(userId);
        this.pumpProfiles();
      });
    }
  }

  private async fetchProfile(userId: string): Promise<void> {
    const peer = this.directory.get(userId);
    if (!peer) return;
    if (!this.links.isReady(userId)) {
      if (!peer.online || !peer.address || !peer.port) return;
      if (!(await this.links.ensureLink(userId, peer.address, peer.port))) {
        this.profileFailed(userId);
        return;
      }
    }
    try {
      const reply = await this.links.request(userId, 'profile.get', { userId });
      const body = ProfileDataBody.safeParse(reply.body);
      const profile = body.success
        ? verifyProfile(body.data.profile, userId, peer.publicKey)
        : undefined;
      if (profile) {
        this.directory.setProfile(userId, SignedProfile.parse(profile));
        this.profileRetry.delete(userId);
      } else {
        this.o.logger.warn('peer sent an invalid profile', { userId });
        this.profileFailed(userId);
      }
    } catch (err) {
      this.o.logger.debug('profile fetch failed', { userId, err: String(err) });
      this.profileFailed(userId);
    }
  }

  private profileFailed(userId: string): void {
    const failures = (this.profileRetry.get(userId)?.failures ?? 0) + 1;
    const delay = Math.min(PROFILE_RETRY_BASE_MS * 2 ** (failures - 1), PROFILE_RETRY_MAX_MS);
    this.profileRetry.set(userId, { failures, at: this.o.clock.now() + delay });
  }

  /**
   * Mark silent peers offline. A peer with an open link gets one quick probe first, so a
   * live link keeps it online and a dead one is noticed within the 20 s budget.
   */
  private sweep(): void {
    for (const peer of this.directory.silentPeers()) {
      if (!this.links.isReady(peer.userId)) {
        this.directory.setOffline(peer);
        this.o.onPeerOnlineChanged(peer);
        continue;
      }
      if (this.probing.has(peer.userId)) continue;
      this.probing.add(peer.userId);
      void this.links.probe(peer.userId, PROBE_TIMEOUT_MS).then((alive) => {
        this.probing.delete(peer.userId);
        if (alive) {
          this.directory.confirmAlive(peer.userId);
          return;
        }
        this.links.disconnect(peer.userId, 'unreachable');
        this.directory.setOffline(peer);
        this.o.onPeerOnlineChanged(peer);
      });
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.sweepTimer) this.o.clock.clearInterval(this.sweepTimer);
    await this.discovery.stop();
    await this.links.stop();
    this.directory.flush();
    this.directory.close();
  }
}
