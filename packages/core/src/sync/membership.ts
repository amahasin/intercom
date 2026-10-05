import {
  ChannelArchiveBody,
  ChannelCreateBody,
  ChannelRenameBody,
  ConvRenameBody,
  decodeBase64Url,
  GroupCreateBody,
  LogEvent,
  MemberAddBody,
  MemberLeaveBody,
  MemberRemoveBody,
  MemberRoleBody,
  MEMBERSHIP_EVENT_TYPES,
  TeamCreateBody,
  TeamRenameBody,
  type Hlc,
  type Member,
} from '@officemesh/protocol';
import { userIdFromSpki } from '../identity/crypto.ts';
import { channelConvId, generalChannelId, genesisConvId } from './ids.ts';

export type Role = 'owner' | 'member';

interface Change {
  t: number;
  c: number;
  member: boolean;
}

/** Who belongs to a group, a team, or a private channel, over time. */
export class Scope {
  readonly current = new Map<string, Role>();
  private readonly history = new Map<string, Change[]>();

  set(userId: string, role: Role, at: Hlc): void {
    const was = this.current.has(userId);
    this.current.set(userId, role);
    if (!was) this.record(userId, true, at);
  }

  remove(userId: string, at: Hlc): void {
    if (!this.current.delete(userId)) return;
    this.record(userId, false, at);
  }

  private record(userId: string, member: boolean, at: Hlc): void {
    let list = this.history.get(userId);
    if (!list) this.history.set(userId, (list = []));
    list.push({ t: at.t, c: at.c, member });
  }

  /** Was `userId` a member at this HLC? Changes at the same HLC count as already applied. */
  memberAt(userId: string, at: Hlc): boolean {
    const list = this.history.get(userId);
    if (!list) return false;
    let member = false;
    for (const ch of list) {
      if (ch.t > at.t || (ch.t === at.t && ch.c > at.c)) break;
      member = ch.member;
    }
    return member;
  }

  /** When a former member's membership last ended (undefined for current or never members). */
  leftAt(userId: string): Hlc | undefined {
    if (this.current.has(userId)) return undefined;
    const last = this.history.get(userId)?.at(-1);
    return last && !last.member ? { t: last.t, c: last.c } : undefined;
  }

  ever(userId: string): boolean {
    return this.history.has(userId);
  }

  /** A stable fingerprint, to tell whether re-materialising is needed. */
  signature(): string {
    return JSON.stringify([...this.history].sort(([a], [b]) => (a < b ? -1 : 1)));
  }
}

export interface ChannelState {
  channelId: string;
  name: string;
  description?: string;
  private: boolean;
  archived: boolean;
  general: boolean;
  createdAt: number;
  /** Private channels only; standard channels follow the team's membership. */
  scope?: Scope;
}

export interface Timeline {
  convId: string;
  kind: 'group' | 'team';
  /** The genesis event arrived and checked out; without it nobody is a member. */
  valid: boolean;
  creator?: string;
  title?: string;
  description?: string;
  visibility?: 'public' | 'private';
  scope: Scope;
  /** Public keys and names learnt from member lists (each key hashes to its userId). */
  keys: Map<string, { spki: string; name: string }>;
  channels: Map<string, ChannelState>;
}

const sortKey = (e: LogEvent) => [e.hlc.t, e.hlc.c, e.author, e.seq] as const;
function compare(a: LogEvent, b: LogEvent): number {
  const x = sortKey(a);
  const y = sortKey(b);
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return 0;
}

/** A member entry whose key really hashes to its userId. */
function validMember(m: Member): boolean {
  try {
    return userIdFromSpki(decodeBase64Url(m.spki)) === m.userId;
  } catch {
    return false;
  }
}

/**
 * Replay a group's or team's membership and control events in HLC order (author, then
 * seq, break ties), applying the authorisation rules of plan section 8:
 * - groups: any current member may add, remove or rename; anyone may leave;
 * - teams: only owners (at that point in the log) may add, remove, change roles, rename,
 *   or create, rename and archive channels; anyone may leave; on a public team a
 *   non-member may add only themselves.
 * The result depends only on the set of events, never on arrival order.
 */
export function computeTimeline(convId: string, kind: 'group' | 'team', raw: unknown[]): Timeline {
  const tl: Timeline = {
    convId,
    kind,
    valid: false,
    scope: new Scope(),
    keys: new Map(),
    channels: new Map(),
  };
  const events = raw
    .map((r) => LogEvent.safeParse(r))
    .filter((p) => p.success && MEMBERSHIP_EVENT_TYPES.has(p.data.type))
    .map((p) => p.data!)
    .sort(compare);

  const learn = (members: Member[]) => {
    for (const m of members)
      if (validMember(m) && !tl.keys.has(m.userId))
        tl.keys.set(m.userId, { spki: m.spki, name: m.name });
  };
  const isOwner = (u: string) => tl.scope.current.get(u) === 'owner';
  const isMember = (u: string) => tl.scope.current.has(u);

  for (const ev of events) {
    const at = ev.hlc;
    if (!tl.valid) {
      // Nothing counts before a genuine genesis.
      const genesisType = kind === 'group' ? 'group.create' : 'team.create';
      if (
        ev.type !== genesisType ||
        ev.seq !== 1 ||
        genesisConvId(genesisType, ev.author, ev.body) !== convId
      )
        continue;
      if (kind === 'group') {
        const body = GroupCreateBody.safeParse(ev.body);
        if (!body.success) continue;
        const members = body.data.members.filter(validMember);
        if (!members.some((m) => m.userId === ev.author)) continue;
        learn(members);
        for (const m of members) tl.scope.set(m.userId, 'member', at);
        if (body.data.title) tl.title = body.data.title;
      } else {
        const body = TeamCreateBody.safeParse(ev.body);
        if (!body.success) continue;
        const members = body.data.members.filter(validMember);
        if (!members.some((m) => m.userId === ev.author)) continue;
        learn(members);
        for (const m of members)
          tl.scope.set(m.userId, m.userId === ev.author ? 'owner' : (m.role ?? 'member'), at);
        tl.title = body.data.name;
        if (body.data.description) tl.description = body.data.description;
        tl.visibility = body.data.visibility;
        if (body.data.general === generalChannelId(ev.author, body.data.nonce)) {
          tl.channels.set(body.data.general, {
            channelId: body.data.general,
            name: 'General',
            private: false,
            archived: false,
            general: true,
            createdAt: at.t,
          });
        }
      }
      tl.valid = true;
      tl.creator = ev.author;
      continue;
    }

    switch (ev.type) {
      case 'member.add': {
        const body = MemberAddBody.safeParse(ev.body);
        if (!body.success) break;
        const members = body.data.members.filter(validMember);
        if (body.data.channelId) {
          const ch = tl.channels.get(body.data.channelId);
          if (kind !== 'team' || !ch?.scope || !isOwner(ev.author)) break;
          learn(members);
          for (const m of members) if (isMember(m.userId)) ch.scope.set(m.userId, 'member', at);
          break;
        }
        const selfJoin =
          kind === 'team' &&
          tl.visibility === 'public' &&
          members.length === 1 &&
          members[0]!.userId === ev.author &&
          !isMember(ev.author);
        const allowed = kind === 'group' ? isMember(ev.author) : isOwner(ev.author) || selfJoin;
        if (!allowed) break;
        learn(members);
        for (const m of members) {
          if (isMember(m.userId)) continue;
          tl.scope.set(
            m.userId,
            kind === 'team' && !selfJoin ? (m.role ?? 'member') : 'member',
            at,
          );
        }
        break;
      }
      case 'member.remove': {
        const body = MemberRemoveBody.safeParse(ev.body);
        if (!body.success) break;
        if (body.data.channelId) {
          const ch = tl.channels.get(body.data.channelId);
          if (kind === 'team' && ch?.scope && isOwner(ev.author))
            ch.scope.remove(body.data.userId, at);
          break;
        }
        const allowed = kind === 'group' ? isMember(ev.author) : isOwner(ev.author);
        if (!allowed) break;
        tl.scope.remove(body.data.userId, at);
        for (const ch of tl.channels.values()) ch.scope?.remove(body.data.userId, at);
        break;
      }
      case 'member.leave': {
        const body = MemberLeaveBody.safeParse(ev.body);
        if (!body.success) break;
        if (body.data.channelId) {
          tl.channels.get(body.data.channelId)?.scope?.remove(ev.author, at);
          break;
        }
        tl.scope.remove(ev.author, at);
        for (const ch of tl.channels.values()) ch.scope?.remove(ev.author, at);
        break;
      }
      case 'member.role': {
        const body = MemberRoleBody.safeParse(ev.body);
        if (kind !== 'team' || !body.success || !isOwner(ev.author) || !isMember(body.data.userId))
          break;
        tl.scope.set(body.data.userId, body.data.role, at);
        break;
      }
      case 'conv.rename': {
        const body = ConvRenameBody.safeParse(ev.body);
        if (kind === 'group' && body.success && isMember(ev.author)) tl.title = body.data.title;
        break;
      }
      case 'team.rename': {
        const body = TeamRenameBody.safeParse(ev.body);
        if (kind !== 'team' || !body.success || !isOwner(ev.author)) break;
        tl.title = body.data.name;
        if (body.data.description !== undefined) tl.description = body.data.description;
        break;
      }
      case 'channel.create': {
        const body = ChannelCreateBody.safeParse(ev.body);
        if (kind !== 'team' || !body.success || !isOwner(ev.author)) break;
        const { channelId } = body.data;
        if (
          tl.channels.has(channelId) ||
          channelId !== channelConvId(convId, ev.author, body.data.nonce)
        )
          break;
        const ch: ChannelState = {
          channelId,
          name: body.data.name,
          private: body.data.private,
          archived: false,
          general: false,
          createdAt: at.t,
          ...(body.data.description && { description: body.data.description }),
        };
        if (body.data.private) {
          ch.scope = new Scope();
          ch.scope.set(ev.author, 'member', at);
          for (const u of body.data.members ?? []) if (isMember(u)) ch.scope.set(u, 'member', at);
        }
        tl.channels.set(channelId, ch);
        break;
      }
      case 'channel.rename': {
        const body = ChannelRenameBody.safeParse(ev.body);
        const ch = body.success ? tl.channels.get(body.data.channelId) : undefined;
        if (kind === 'team' && ch && isOwner(ev.author)) ch.name = body.data!.name;
        break;
      }
      case 'channel.archive': {
        const body = ChannelArchiveBody.safeParse(ev.body);
        const ch = body.success ? tl.channels.get(body.data.channelId) : undefined;
        if (kind === 'team' && ch && !ch.general && isOwner(ev.author))
          ch.archived = body.data!.archived;
        break;
      }
    }
  }
  return tl;
}

/** Members of a channel: its own scope if private, otherwise the team's. */
export function channelScope(team: Timeline, channelId: string): Scope | undefined {
  const ch = team.channels.get(channelId);
  if (!ch) return undefined;
  return ch.scope ?? team.scope;
}
