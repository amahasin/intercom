import type { KeyObject } from 'node:crypto';
import {
  BEACON_INTERVAL_MS,
  isWorkplace,
  MachineInfo,
  PEER_OFFLINE_AFTER_MS,
  SignedProfile,
  type PresenceState,
  type SignedBeacon,
} from '@officemesh/protocol';
import type { PeerTrust, PersonView } from '@officemesh/protocol/ipc';
import { importPublicKeySpki, userIdFromSpki } from '../identity/crypto.ts';
import { safetyPhrase } from '../identity/safety-phrase.ts';
import type { Clock, Logger, TimerHandle } from '../interfaces.ts';
import type { PeerRepo } from '../store/peers.ts';

/** Persist last-seen at most this often per peer, not on every beacon. */
const LAST_SEEN_PERSIST_MS = 60_000;
/** Keep using an address until it has been silent for two beacon intervals. */
const ADDRESS_STICKY_MS = 2 * BEACON_INTERVAL_MS;
const NOTIFY_BATCH_MS = 200;

export interface Peer {
  userId: string;
  spki: Buffer;
  publicKey: KeyObject;
  profile: SignedProfile | undefined;
  firstSeen: number;
  lastSeen: number;
  lastSeenPersisted: number;
  /** Every address a beacon came from recently, with when. */
  addresses: Map<string, number>;
  address: string | undefined;
  port: number | undefined;
  online: boolean;
  presence: PresenceState;
  /** When they last changed state (from their beacon, else when this PC first saw the state). */
  presenceSince?: number | undefined;
  inCall: boolean;
  lastBeaconAt: number;
  /** Last time an open link proved the peer alive (probe answered). */
  lastLivenessAt: number;
  advertisedProfileVersion: number;
  trust: PeerTrust;
  verified: boolean;
  phrase: string[];
  /** Removed from the list by the user; cleared when the person is seen online again. */
  hidden?: boolean;
  /** The InterCom version and PC they last reported, and when. */
  info?: PeerInfo;
}

/** What a colleague last told this PC about itself (kept, so it shows while they are offline). */
export interface PeerInfo {
  app: string;
  machine?: MachineInfo | undefined;
  at: number;
}

export interface BeaconOutcome {
  peer: Peer;
  isNew: boolean;
  cameOnline: boolean;
  profileStale: boolean;
}

export interface DirectoryOptions {
  repo: PeerRepo;
  clock: Clock;
  logger: Logger;
  selfId: string;
  /** Own display name, so a newcomer using it is flagged too. */
  selfName: () => string;
}

/** The stored JSON of a peer's reported info, if it is one. */
function readInfo(json: string | null | undefined): PeerInfo | undefined {
  if (!json) return undefined;
  try {
    const raw = JSON.parse(json) as { app?: unknown; machine?: unknown; at?: unknown };
    if (typeof raw.app !== 'string' || typeof raw.at !== 'number') return undefined;
    const machine = MachineInfo.safeParse(raw.machine);
    return {
      app: raw.app.slice(0, 32),
      at: raw.at,
      ...(machine.success && { machine: machine.data }),
    };
  } catch {
    return undefined;
  }
}

/**
 * Everyone this PC knows about: pinned keys (trust on first use), profiles, addresses,
 * and who is online now. Change notifications are batched for the UI.
 */
export class PeerDirectory {
  private readonly opts: DirectoryOptions;
  private readonly peers = new Map<string, Peer>();
  private readonly dirty = new Set<string>();
  private readonly listeners = new Set<(userIds: string[]) => void>();
  private flushTimer: TimerHandle | undefined;

  constructor(options: DirectoryOptions) {
    this.opts = options;
    for (const row of options.repo.all()) {
      let profile: SignedProfile | undefined;
      if (row.profileJson) {
        const parsed = SignedProfile.safeParse(JSON.parse(row.profileJson));
        if (parsed.success) profile = parsed.data;
      }
      this.peers.set(row.userId, {
        userId: row.userId,
        spki: row.publicKey,
        publicKey: importPublicKeySpki(row.publicKey),
        profile,
        firstSeen: row.firstSeen,
        lastSeen: row.lastSeen,
        lastSeenPersisted: row.lastSeen,
        addresses: new Map(),
        address: row.lastAddress ?? undefined,
        port: row.lastPort ?? undefined,
        online: false,
        presence: 'offline',
        inCall: false,
        lastBeaconAt: 0,
        lastLivenessAt: 0,
        advertisedProfileVersion: profile?.version ?? 0,
        trust: row.trust,
        verified: row.verified === 1,
        phrase: safetyPhrase(row.publicKey),
        hidden: row.hidden === 1,
        ...(readInfo(row.infoJson) && { info: readInfo(row.infoJson)! }),
      });
    }
  }

  get(userId: string): Peer | undefined {
    return this.peers.get(userId);
  }

  all(): Peer[] {
    return [...this.peers.values()];
  }

  onlineCount(): number {
    let n = 0;
    for (const p of this.peers.values()) if (p.online) n++;
    return n;
  }

  /**
   * Make sure a peer whose key was proven some other way (a TLS link) is known. The
   * key is pinned on first sight; the userId is a hash of it, so it cannot differ.
   */
  learn(userId: string, spki: Buffer): Peer {
    const existing = this.peers.get(userId);
    if (existing) return existing;
    if (userIdFromSpki(spki) !== userId) throw new Error('key does not match userId');
    const now = this.opts.clock.now();
    const peer: Peer = {
      userId,
      spki,
      publicKey: importPublicKeySpki(spki),
      profile: undefined,
      firstSeen: now,
      lastSeen: now,
      lastSeenPersisted: now,
      addresses: new Map(),
      address: undefined,
      port: undefined,
      online: false,
      presence: 'offline',
      inCall: false,
      lastBeaconAt: 0,
      lastLivenessAt: 0,
      advertisedProfileVersion: 0,
      trust: 'normal',
      verified: false,
      phrase: safetyPhrase(spki),
    };
    this.peers.set(userId, peer);
    this.opts.repo.insert({
      userId,
      publicKey: spki,
      profileJson: null,
      displayName: null,
      firstSeen: now,
      lastSeen: now,
      lastAddress: null,
      lastPort: null,
      trust: 'normal',
      verified: 0,
    });
    this.markDirty(userId);
    return peer;
  }

  /** Apply a verified `alive` or `bye` beacon. */
  onBeacon(beacon: SignedBeacon, spki: Buffer, from: string): BeaconOutcome {
    const now = this.opts.clock.now();
    const isNew = !this.peers.has(beacon.userId);
    const peer = this.learn(beacon.userId, spki);

    if (beacon.kind === 'bye') {
      if (peer.online) this.setOffline(peer);
      return { peer, isNew, cameOnline: false, profileStale: false };
    }

    peer.addresses.set(from, now);
    const current = peer.address !== undefined ? peer.addresses.get(peer.address) : undefined;
    const addressChanged =
      peer.address !== from && (current === undefined || now - current > ADDRESS_STICKY_MS);
    if (addressChanged) peer.address = from;
    const portChanged = peer.port !== beacon.port;
    peer.port = beacon.port;
    for (const [addr, at] of peer.addresses)
      if (now - at > PEER_OFFLINE_AFTER_MS) peer.addresses.delete(addr);

    const cameOnline = !peer.online;
    if (cameOnline && peer.hidden) this.setHidden(peer.userId, false);
    const presenceChanged =
      peer.presence !== beacon.presence || peer.inCall !== (beacon.inCall === true);
    // "Last seen" for someone away: their own word for when it began, if they send it.
    const claimed =
      beacon.since !== undefined &&
      beacon.since <= now + 60_000 &&
      beacon.since > now - 30 * 86_400_000
        ? beacon.since
        : undefined;
    const sinceBefore = peer.presenceSince;
    peer.presenceSince =
      claimed ?? (presenceChanged || cameOnline || sinceBefore === undefined ? now : sinceBefore);
    peer.online = true;
    peer.presence = beacon.presence;
    peer.inCall = beacon.inCall === true;
    peer.lastBeaconAt = now;
    peer.lastSeen = now;
    peer.advertisedProfileVersion = beacon.profileVer;

    if (addressChanged || portChanged || now - peer.lastSeenPersisted > LAST_SEEN_PERSIST_MS) {
      peer.lastSeenPersisted = now;
      this.opts.repo.setSeen(peer.userId, now, peer.address ?? null, peer.port ?? null);
    }
    if (cameOnline || presenceChanged || isNew || peer.presenceSince !== sinceBefore)
      this.markDirty(peer.userId);
    const profileStale = beacon.profileVer > (peer.profile?.version ?? 0);
    return { peer, isNew, cameOnline, profileStale };
  }

  /** A link answered a liveness probe: keep the peer online without beacons. */
  confirmAlive(userId: string): void {
    const peer = this.peers.get(userId);
    if (peer) peer.lastLivenessAt = this.opts.clock.now();
  }

  /** Online peers not heard from (beacon or link liveness) within the offline window. */
  silentPeers(): Peer[] {
    const now = this.opts.clock.now();
    return this.all().filter(
      (p) => p.online && now - Math.max(p.lastBeaconAt, p.lastLivenessAt) > PEER_OFFLINE_AFTER_MS,
    );
  }

  setOffline(peer: Peer): void {
    if (!peer.online) return;
    peer.online = false;
    peer.presence = 'offline';
    peer.presenceSince = undefined;
    peer.inCall = false;
    peer.lastSeenPersisted = peer.lastSeen;
    this.opts.repo.setSeen(peer.userId, peer.lastSeen, peer.address ?? null, peer.port ?? null);
    this.markDirty(peer.userId);
  }

  /** Store a verified profile, flagging a newcomer that reuses a known name. */
  setProfile(userId: string, profile: SignedProfile): boolean {
    const peer = this.peers.get(userId);
    if (!peer || profile.userId !== userId) return false;
    if (peer.profile && peer.profile.version >= profile.version) return false;
    peer.profile = profile;
    this.opts.repo.setProfile(userId, JSON.stringify(profile), profile.displayName);
    if (
      peer.trust === 'normal' &&
      !peer.verified &&
      this.nameAlreadyKnown(peer, profile.displayName)
    ) {
      peer.trust = 'new-device';
      this.opts.repo.setTrust(userId, 'new-device');
      this.opts.logger.warn('known display name appeared under a new key', { userId });
    }
    this.markDirty(userId);
    return true;
  }

  private nameAlreadyKnown(peer: Peer, name: string): boolean {
    if (name.localeCompare(this.opts.selfName(), undefined, { sensitivity: 'accent' }) === 0)
      return true;
    return this.opts.repo
      .othersWithName(name, peer.userId)
      .some((other) => other.firstSeen <= peer.firstSeen);
  }

  setTrust(userId: string, change: { accept?: boolean; verified?: boolean }): Peer | undefined {
    const peer = this.peers.get(userId);
    if (!peer) return undefined;
    if (change.accept && peer.trust === 'new-device') {
      peer.trust = 'accepted';
      this.opts.repo.setTrust(userId, 'accepted');
    }
    if (change.verified !== undefined) {
      peer.verified = change.verified;
      this.opts.repo.setVerified(userId, change.verified);
      if (change.verified && peer.trust === 'new-device') {
        peer.trust = 'accepted';
        this.opts.repo.setTrust(userId, 'accepted');
      }
    }
    this.markDirty(userId);
    return peer;
  }

  /** Take a person off the people list (or put them back); their chats are not touched. */
  setHidden(userId: string, hidden: boolean): Peer | undefined {
    const peer = this.peers.get(userId);
    if (!peer) return undefined;
    peer.hidden = hidden;
    this.opts.repo.setHidden(userId, hidden);
    this.markDirty(userId);
    return peer;
  }

  /** A colleague's `hello` told us their version and PC: keep it, and tell the UI if it changed. */
  setInfo(userId: string, app: string, machine: MachineInfo | undefined): void {
    const peer = this.peers.get(userId);
    if (!peer) return;
    const before = peer.info;
    if (
      before &&
      before.app === app &&
      JSON.stringify(before.machine) === JSON.stringify(machine)
    ) {
      // The same facts again: they are confirmed as of now ("Reported just now"), and a page that
      // is open hears of it once the old time has grown stale enough to matter.
      const now = this.opts.clock.now();
      const stale = now - before.at > 60_000;
      before.at = now;
      if (stale) {
        this.opts.repo.setInfo(userId, JSON.stringify(before));
        this.markDirty(userId);
      }
      return;
    }
    peer.info = { app, ...(machine && { machine }), at: this.opts.clock.now() };
    this.opts.repo.setInfo(userId, JSON.stringify(peer.info));
    this.markDirty(userId);
  }

  view(peer: Peer): PersonView {
    const p = peer.profile;
    return {
      userId: peer.userId,
      ...(p && { displayName: p.displayName }),
      ...(p?.jobTitle !== undefined && { jobTitle: p.jobTitle }),
      ...(p?.statusMessage !== undefined &&
        (p.statusExpiresAt === undefined || p.statusExpiresAt > this.opts.clock.now()) && {
          statusMessage: p.statusMessage,
        }),
      ...(p?.avatarHash !== undefined && { avatarHash: p.avatarHash }),
      ...(p?.email !== undefined && { email: p.email }),
      ...(p && isWorkplace(p.workplace) && { workplace: p.workplace }),
      ...(p?.notes !== undefined && { notes: p.notes }),
      presence: peer.online ? peer.presence : 'offline',
      ...(peer.online && peer.presenceSince !== undefined && { presenceSince: peer.presenceSince }),
      ...(peer.online && peer.inCall && { inCall: true }),
      online: peer.online,
      lastSeen: peer.lastSeen,
      trust: peer.trust,
      verified: peer.verified,
      safetyPhrase: peer.phrase,
      firstSeen: peer.firstSeen,
      ...(peer.address !== undefined && { address: peer.address }),
      ...(peer.info?.app && { appVersion: peer.info.app }),
      ...(peer.info?.machine && { machine: peer.info.machine }),
      ...(peer.info && { infoAt: peer.info.at }),
      hidden: peer.hidden === true,
    };
  }

  onChange(listener: (userIds: string[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  markDirty(userId: string): void {
    this.dirty.add(userId);
    if (this.flushTimer) return;
    this.flushTimer = this.opts.clock.setTimeout(() => this.flush(), NOTIFY_BATCH_MS);
  }

  /** Deliver pending change notifications now. */
  flush(): void {
    if (this.flushTimer) this.opts.clock.clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.dirty.size === 0) return;
    const ids = [...this.dirty];
    this.dirty.clear();
    for (const l of this.listeners) l(ids);
  }

  close(): void {
    if (this.flushTimer) this.opts.clock.clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    for (const peer of this.peers.values()) {
      if (peer.lastSeen > peer.lastSeenPersisted) {
        this.opts.repo.setSeen(peer.userId, peer.lastSeen, peer.address ?? null, peer.port ?? null);
      }
    }
  }
}
