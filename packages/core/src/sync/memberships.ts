import { MEMBERSHIP_EVENT_TYPES, type Hlc } from '@officemesh/protocol';
import type { ConversationRepo } from '../store/conversations.ts';
import {
  channelScope,
  computeTimeline,
  type Role,
  type Scope,
  type Timeline,
} from './membership.ts';

const TYPES = [...MEMBERSHIP_EVENT_TYPES];

/**
 * Cached membership timelines per group and team, recomputed from the log whenever a
 * membership or control event is stored. Direct chats always have exactly two members.
 */
export class Memberships {
  private readonly repo: ConversationRepo;
  private readonly cache = new Map<string, Timeline>();

  constructor(repo: ConversationRepo) {
    this.repo = repo;
  }

  invalidate(convId: string): void {
    this.cache.delete(convId);
  }

  /** The timeline governing a conversation: its own (group, team) or its team's (channel). */
  timeline(convId: string): Timeline | undefined {
    const row = this.repo.get(convId);
    if (!row) return undefined;
    const owner = row.kind === 'channel' ? row.teamId : row.kind === 'direct' ? null : convId;
    if (!owner) return undefined;
    let tl = this.cache.get(owner);
    if (!tl) {
      const kind = owner === convId ? (row.kind as 'group' | 'team') : 'team';
      tl = computeTimeline(
        owner,
        kind,
        this.repo.eventsOfTypes(owner, TYPES).map((j) => JSON.parse(j) as unknown),
      );
      this.cache.set(owner, tl);
    }
    return tl;
  }

  scope(convId: string): Scope | undefined {
    const row = this.repo.get(convId);
    const tl = this.timeline(convId);
    if (!row || !tl?.valid) return undefined;
    return row.kind === 'channel' ? channelScope(tl, convId) : tl.scope;
  }

  /** May `author`'s event at `hlc` count in this conversation? */
  allowed(convId: string, author: string, hlc: Hlc): boolean {
    const row = this.repo.get(convId);
    if (!row) return false;
    if (row.kind === 'direct') return true;
    if (row.kind === 'team') return false; // the control log carries no messages
    return this.scope(convId)?.memberAt(author, hlc) ?? false;
  }

  current(convId: string): Map<string, Role> {
    const row = this.repo.get(convId);
    if (row?.kind === 'direct')
      return new Map(this.repo.members(convId).map((u) => [u, 'member' as Role]));
    return new Map(this.scope(convId)?.current ?? []);
  }

  /** Ever a member here (or, for a channel, of its team): their events may be stored. */
  ever(convId: string, userId: string): boolean {
    const row = this.repo.get(convId);
    if (!row) return false;
    if (row.kind === 'direct') return this.repo.isMember(convId, userId);
    const tl = this.timeline(convId);
    return tl?.valid === true && tl.scope.ever(userId);
  }

  /** For a former member: the HLC their membership ended, up to which they may sync. */
  leftAt(convId: string, userId: string): Hlc | undefined {
    return this.scope(convId)?.leftAt(userId);
  }

  keyOf(convId: string, userId: string): string | undefined {
    return this.timeline(convId)?.keys.get(userId)?.spki;
  }
}
