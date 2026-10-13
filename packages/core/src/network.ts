import {
  DEFAULT_LINK_PORT,
  MAX_EXCHANGED_PEERS,
  PeersExchangeBody,
  REMOTE_KEEPALIVE_MS,
  SignedProfile,
  type KnownPeer,
  type PresenceState,
} from '@officemesh/protocol';
import {
  AvatarDataBody,
  AvatarGetBody,
  decodeBase64Url,
  encodeBase64Url,
  ProfileDataBody,
  ProfileGetBody,
} from '@officemesh/protocol';
import { BeaconVerifier, encodeBeacon } from './discovery/beacon.ts';
import { EnvelopeService } from './sync/envelopes.ts';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256, userIdFromSpki } from './identity/crypto.ts';
import type { MessageRepo } from './store/messages.ts';
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
/** Colleagues added by address, and remote peers that went away, are re-dialed this often. */
const REMOTE_REDIAL_MS = 60_000;
/** New remote peers are passed on to local colleagues after this pause (bursts coalesce). */
const SHARE_DELAY_MS = 2_000;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export interface PeerNetworkOptions {
  identity: Identity;
  store: Store;
  conversations: ConversationRepo;
  messages: MessageRepo;
  /** Where avatars are cached, as `<sha256>.<ext>` (served to the UI by the host). */
  avatarDir: string;
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
  /** Public teams to advertise to colleagues in `hello`. */
  publicTeams?: () => Array<{ teamId: string; name: string }>;
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
  readonly envelopes: EnvelopeService;
  private readonly o: PeerNetworkOptions;
  private readonly profileQueue = new Set<string>();
  private readonly profileInflight = new Set<string>();
  private readonly profileRetry = new Map<string, { failures: number; at: number }>();
  private readonly probing = new Set<string>();
  private readonly skewed = new Set<string>();
  private sweepTimer: TimerHandle | undefined;
  private stopped = false;
  /** Peers seen by UDP beacon this session: on our subnet. */
  private readonly local = new Set<string>();
  /** Peers known only through links (another subnet), kept alive over the link. */
  private readonly remote = new Set<string>();
  /** Typed addresses ("ip:port") and who answered there last. */
  private readonly manual = new Map<string, string | undefined>();
  private readonly beacons = new BeaconVerifier();
  private lastKeepalive = 0;
  private lastRedial = 0;
  private shareTimer: TimerHandle | undefined;
  /** Remote peers learnt since the last share with local colleagues. */
  private readonly unshared = new Set<string>();

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
      ...(options.publicTeams && { publicTeams: options.publicTeams }),
    });
    // Learn the peer's key before any of its messages are handled.
    this.links.onLinkUp((userId) => this.onLinkUp(userId));
    this.links.on('profile.get', (_from, body) => {
      const { userId } = ProfileGetBody.parse(body);
      if (userId === identity.userId)
        return { type: 'profile.data', body: { profile: identity.profile } };
    });
    this.links.on('avatar.get', async (_from, body) => {
      const { userId, hash } = AvatarGetBody.parse(body);
      if (userId !== identity.userId || hash !== identity.profile.avatarHash) return;
      const found = await this.readAvatar(hash);
      if (found)
        return {
          type: 'avatar.data',
          body: { hash, mime: found.mime, data: encodeBase64Url(found.data) },
        };
    });
    this.sync = new SyncEngine({
      repo: options.conversations,
      messages: options.messages,
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
      envelopes: {
        seal: (convId, seq, to, event) => this.envelopes.seal(convId, seq, to, event),
        acked: (convId, upto) => this.envelopes.acked(convId, upto),
        carried: (convId, seq) => this.envelopes.carried(convId, seq),
      },
    });
    this.envelopes = new EnvelopeService({
      db: options.store.db,
      selfId: identity.userId,
      privateKey: identity.privateKey,
      spki: identity.spki,
      links: this.links,
      clock,
      logger,
      keyFor: (userId) => this.directory.get(userId)?.publicKey,
      onlinePeers: () =>
        this.directory
          .all()
          .filter((p) => p.online)
          .map((p) => p.userId),
      connect: (userId) => this.connect(userId),
      deliver: (author, spki, event) => {
        try {
          this.directory.learn(author, spki);
        } catch {
          return false;
        }
        this.sync.applySealed(author, event);
        return true;
      },
      carriersChanged: (convId, seqs) =>
        options.syncEvents.statusChanged(
          convId,
          seqs.map((seq) => ({ author: identity.userId, seq })),
        ),
    });
    this.links.on('peers.exchange', (from, body) =>
      this.onExchange(from, PeersExchangeBody.parse(body)),
    );
    this.discovery = new DiscoveryService({
      driver: options.discovery,
      signer: identity,
      clock,
      logger,
      fields: () => ({
        port: this.links.port ?? 0,
        presence: options.presence.effective(),
        ...(options.presence.isInCall() && { inCall: true }),
        profileVer: identity.profile.version,
      }),
      onBeacon: (beacon, spki, _key, from) => {
        const outcome = this.directory.onBeacon(beacon, spki, from.address);
        if (beacon.kind === 'bye') {
          this.o.onPeerOnlineChanged(outcome.peer);
          return;
        }
        // Heard by multicast: on our subnet, so no keepalive over the link is needed.
        this.local.add(beacon.userId);
        this.remote.delete(beacon.userId);
        if (outcome.profileStale) this.queueProfile(beacon.userId);
        if (outcome.cameOnline) {
          this.o.onPeerOnlineChanged(outcome.peer);
          this.envelopes.offer(beacon.userId);
        }
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
    this.keepalive();
  }

  /** Before sleep: say bye and drop links; peers show us Offline at once. */
  suspend(): void {
    this.discovery.sayBye();
    for (const userId of this.links.readyPeers()) this.links.disconnect(userId, 'sleeping');
  }

  resume(): void {
    this.discovery.announce();
    this.keepalive();
  }

  /** Open a link to a peer if it is reachable; failures back off inside the link manager. */
  /** Open (or reuse) a link to a colleague; resolves false if they cannot be reached. */
  connect(userId: string): Promise<boolean> {
    if (this.links.isReady(userId)) return Promise.resolve(true);
    const peer = this.directory.get(userId);
    if (!peer?.address || !peer.port) return Promise.resolve(false);
    return this.links.ensureLink(userId, peer.address, peer.port).catch(() => false);
  }

  dial(userId: string): void {
    const peer = this.directory.get(userId);
    if (!peer?.online || !peer.address || !peer.port) return;
    void this.links.ensureLink(userId, peer.address, peer.port);
  }

  private onLinkUp(userId: string): void {
    const spki = this.links.remoteSpki(userId);
    if (!spki) return;
    const peer = this.directory.learn(userId, spki);
    // Not heard on our subnet: a colleague elsewhere, kept fresh over this link.
    if (!this.local.has(userId)) this.remote.add(userId);
    this.sendExchange(userId);
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
        if (profile.avatarHash) void this.fetchAvatar(userId, profile.avatarHash);
      } else {
        this.o.logger.warn('peer sent an invalid profile', { userId });
        this.profileFailed(userId);
      }
    } catch (err) {
      this.o.logger.debug('profile fetch failed', { userId, err: String(err) });
      this.profileFailed(userId);
    }
  }

  /** Cached avatar file for a hash, if present. */
  private async readAvatar(
    hash: string,
  ): Promise<{ data: Buffer; mime: 'image/png' | 'image/jpeg' | 'image/webp' } | undefined> {
    for (const [ext, mime] of AVATAR_TYPES) {
      const path = join(this.o.avatarDir, `${hash}.${ext}`);
      if (existsSync(path)) return { data: await readFile(path), mime };
    }
    return undefined;
  }

  /** Store an avatar under its hash; returns false if the bytes do not match it. */
  async saveAvatar(hash: string, mime: string, data: Uint8Array): Promise<boolean> {
    const ext = AVATAR_TYPES.find(([, m]) => m === mime)?.[0];
    if (!ext || sha256(data).toString('hex') !== hash) return false;
    await mkdir(this.o.avatarDir, { recursive: true });
    await writeFile(join(this.o.avatarDir, `${hash}.${ext}`), data);
    return true;
  }

  private async fetchAvatar(userId: string, hash: string): Promise<void> {
    if (await this.readAvatar(hash)) return;
    try {
      const reply = await this.links.request(userId, 'avatar.get', { userId, hash });
      const body = AvatarDataBody.safeParse(reply.body);
      if (body.success && body.data.hash === hash) {
        if (await this.saveAvatar(hash, body.data.mime, decodeBase64Url(body.data.data)))
          this.directory.markDirty(userId);
      }
    } catch (err) {
      this.o.logger.debug('avatar fetch failed', { userId, err: String(err) });
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
    this.sync.tick();
    this.envelopes.tick();
    const now = this.o.clock.now();
    if (now - this.lastKeepalive >= REMOTE_KEEPALIVE_MS) this.keepalive();
    if (now - this.lastRedial >= REMOTE_REDIAL_MS) {
      this.lastRedial = now;
      this.redial();
    }
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

  // -------------------------------------------------------------------------
  // Other subnets (plan section 6, M6)
  // -------------------------------------------------------------------------

  /** Parse "ip" or "ip:port" as typed in Settings. */
  static parseAddress(text: string): { address: string; port: number } | undefined {
    const m = /^\s*(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?\s*$/.exec(text);
    if (!m) return undefined;
    if (m[1]!.split('.').some((o) => Number(o) > 255)) return undefined;
    const port = m[2] ? Number(m[2]) : DEFAULT_LINK_PORT;
    if (port < 1 || port > 65535) return undefined;
    return { address: m[1]!, port };
  }

  /** The typed addresses to keep linked to (from Settings). */
  setManualAddresses(addresses: string[]): void {
    const wanted = new Set(addresses);
    for (const a of [...this.manual.keys()]) if (!wanted.has(a)) this.manual.delete(a);
    for (const a of wanted) if (!this.manual.has(a)) this.manual.set(a, undefined);
    for (const a of wanted) void this.dialManual(a);
  }

  /** Link to a colleague by address; resolves with who answered (undefined: nobody). */
  async dialManual(text: string): Promise<string | undefined> {
    const target = PeerNetwork.parseAddress(text);
    if (!target) return undefined;
    const known = this.manual.get(text);
    if (known && this.links.isReady(known)) return known;
    const userId = await this.links.dialAddress(target.address, target.port);
    if (!userId) return undefined;
    if (this.manual.has(text)) this.manual.set(text, userId);
    const peer = this.directory.get(userId);
    if (peer && !this.local.has(userId)) {
      peer.address = target.address;
      peer.port = target.port;
    }
    return userId;
  }

  remotePeersStatus(): RemotePeersStatus {
    return {
      manual: [...this.manual].map(([address, userId]) => ({
        address,
        userId: userId ?? null,
        linked: userId !== undefined && this.links.isReady(userId),
      })),
      remoteOnline: [...this.remote].filter((u) => this.links.isReady(u)).length,
    };
  }

  isRemote(userId: string): boolean {
    return this.remote.has(userId);
  }

  private ownBeacon(): string {
    return Buffer.from(
      encodeBeacon(this.o.identity, {
        kind: 'alive',
        ts: this.o.clock.now(),
        port: this.links.port ?? 0,
        presence: this.o.presence.effective(),
        ...(this.o.presence.isInCall() && { inCall: true }),
        profileVer: this.o.identity.profile.version,
      }),
    ).toString('utf8');
  }

  /** Online colleagues with the address we reach them on, for a peer list. */
  private knownPeers(filter: (userId: string) => boolean): KnownPeer[] {
    const out: KnownPeer[] = [];
    for (const p of this.directory.all()) {
      if (out.length >= MAX_EXCHANGED_PEERS) break;
      if (!p.online || !p.address || !p.port || !IPV4.test(p.address) || !filter(p.userId))
        continue;
      out.push({
        userId: p.userId,
        pub: encodeBase64Url(p.spki),
        address: p.address,
        port: p.port,
      });
    }
    return out;
  }

  /**
   * On a new link: a remote colleague gets everyone we see online (so one typed address
   * reveals the whole other subnet); a local one gets only the remote peers we know.
   */
  private sendExchange(userId: string): void {
    if (!this.links.hasCap(userId, 'peers.v1')) return;
    const remote = this.remote.has(userId);
    const peers = this.knownPeers((u) => u !== userId && (remote || this.remote.has(u)));
    if (!remote && peers.length === 0) return;
    this.links.send(userId, 'peers.exchange', {
      peers,
      ...(remote && { beacon: this.ownBeacon() }),
    });
  }

  /** Remote peers get our beacon over the link every 15 s (and at once on change). */
  private keepalive(): void {
    this.lastKeepalive = this.o.clock.now();
    if (this.remote.size === 0) return;
    const beacon = this.ownBeacon();
    for (const userId of this.remote) {
      if (this.links.isReady(userId))
        this.links.send(userId, 'peers.exchange', { peers: [], beacon });
    }
  }

  private onExchange(from: string, body: PeersExchangeBody): void {
    if (body.beacon !== undefined) {
      const verdict = this.beacons.verify(Buffer.from(body.beacon, 'utf8'), this.o.clock.now());
      if (verdict.ok && verdict.beacon.userId === from && verdict.beacon.kind === 'alive') {
        const peer = this.directory.get(from);
        const outcome = this.directory.onBeacon(verdict.beacon, verdict.spki, peer?.address ?? '');
        if (outcome.profileStale) this.queueProfile(from);
        if (outcome.cameOnline) this.o.onPeerOnlineChanged(outcome.peer);
      } else if (!verdict.ok && verdict.reason === 'clock-skew' && !this.skewed.has(from)) {
        this.skewed.add(from);
        this.o.onStatusChanged();
      }
    }
    let learnt = false;
    for (const entry of body.peers) {
      if (entry.userId === this.o.identity.userId || this.local.has(entry.userId)) continue;
      let spki: Buffer;
      try {
        spki = Buffer.from(decodeBase64Url(entry.pub));
        if (userIdFromSpki(spki) !== entry.userId) continue;
      } catch {
        continue;
      }
      if (this.links.isReady(entry.userId)) continue;
      const peer = this.directory.learn(entry.userId, spki);
      peer.address = entry.address;
      peer.port = entry.port;
      this.remote.add(entry.userId);
      if (!this.unshared.has(entry.userId)) {
        this.unshared.add(entry.userId);
        learnt = true;
      }
      // TLS proves the key on dial: a false address only fails to connect.
      void this.links.ensureLink(entry.userId, entry.address, entry.port);
    }
    if (learnt) this.scheduleShare();
  }

  /** Pass newly learnt remote peers on to the colleagues on our own subnet. */
  private scheduleShare(): void {
    if (this.shareTimer) return;
    this.shareTimer = this.o.clock.setTimeout(() => {
      this.shareTimer = undefined;
      this.unshared.clear();
      const peers = this.knownPeers((u) => this.remote.has(u));
      if (peers.length === 0) return;
      for (const userId of this.local) {
        const peer = this.directory.get(userId);
        if (!peer?.online || !peer.address || !peer.port) continue;
        void this.links.ensureLink(userId, peer.address, peer.port).then((ok) => {
          if (ok && this.links.hasCap(userId, 'peers.v1'))
            this.links.send(userId, 'peers.exchange', { peers });
        });
      }
    }, SHARE_DELAY_MS);
  }

  /** Re-dial typed addresses and remote peers that dropped (they send no beacons). */
  private redial(): void {
    for (const address of this.manual.keys()) void this.dialManual(address);
    for (const userId of this.remote) {
      const peer = this.directory.get(userId);
      if (peer?.address && peer.port && !this.links.isReady(userId))
        void this.links.ensureLink(userId, peer.address, peer.port);
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.sweepTimer) this.o.clock.clearInterval(this.sweepTimer);
    if (this.shareTimer) this.o.clock.clearTimeout(this.shareTimer);
    await this.discovery.stop();
    await this.links.stop();
    this.directory.flush();
    this.directory.close();
  }
}

export interface RemotePeersStatus {
  /** Addresses typed in Settings, and who answered there. */
  manual: Array<{ address: string; userId: string | null; linked: boolean }>;
  /** Colleagues on other subnets currently linked. */
  remoteOnline: number;
}

const AVATAR_TYPES: Array<[string, 'image/png' | 'image/jpeg' | 'image/webp']> = [
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['webp', 'image/webp'],
];
