import {
  FileShareBody,
  MsgDeleteBody,
  MsgEditBody,
  MsgPinBody,
  MsgPostBody,
  MsgReactBody,
  MsgReadBody,
  PollCloseBody,
  PollCreateBody,
  PollVoteBody,
  type Hlc,
  type LogEvent,
  type MsgRef,
} from '@officemesh/protocol';
import type { ConversationRepo } from '../store/conversations.ts';
import type { MessageRepo, MessageRow } from '../store/messages.ts';
import { toPlain } from './markdown.ts';

export interface Effects {
  /** Messages whose view changed, by conversation. `added` marks brand-new ones. */
  changed: Map<string, { refs: MsgRef[]; added: MsgRef[] }>;
  activity: Array<{ id: number; convId: string }>;
  /** New posts by others, for notifications (live only). */
  incoming: Array<{ convId: string; row: MessageRow }>;
}

export function emptyEffects(): Effects {
  return { changed: new Map(), activity: [], incoming: [] };
}

function touch(fx: Effects, convId: string, ref: MsgRef, added = false): void {
  let entry = fx.changed.get(convId);
  if (!entry) fx.changed.set(convId, (entry = { refs: [], added: [] }));
  if (!entry.refs.some((r) => r.author === ref.author && r.seq === ref.seq)) entry.refs.push(ref);
  if (added) entry.added.push(ref);
}

/**
 * Turns signed log events into the `messages` view and its dependants. Every rule is
 * order-independent (last writer wins by HLC; an edit or delete that arrives before its
 * post is applied when the post lands), so applying events live in arrival order and
 * replaying them in `rebuild` produce the same tables.
 */
export class Materializer {
  private readonly selfId: string;
  private readonly messages: MessageRepo;
  private readonly conversations: ConversationRepo;
  /** Was the author a member of the conversation at the event's time? */
  private readonly allowed: (convId: string, author: string, hlc: Hlc) => boolean;

  constructor(
    selfId: string,
    messages: MessageRepo,
    conversations: ConversationRepo,
    allowed: (convId: string, author: string, hlc: Hlc) => boolean = () => true,
  ) {
    this.selfId = selfId;
    this.messages = messages;
    this.conversations = conversations;
    this.allowed = allowed;
  }

  /** `live` adds activity items and notification candidates; rebuild leaves them alone. */
  apply(ev: LogEvent, live: boolean, fx: Effects): void {
    const self = this.selfId;
    const ref = { author: ev.author, seq: ev.seq };
    // Events by someone who was not a member at the time are kept in the log, not shown.
    if (!this.allowed(ev.convId, ev.author, ev.hlc)) return;
    switch (ev.type) {
      case 'msg.post':
      case 'file.share':
      case 'poll.create': {
        const row = this.postRow(ev);
        if (!row || !this.messages.insert(row)) return;
        // Pick up edits and deletes that arrived before the post did.
        for (const json of this.conversations.targeting(ev.convId, ref, [
          'msg.edit',
          'msg.delete',
        ])) {
          this.apply(JSON.parse(json) as LogEvent, false, fx);
        }
        touch(fx, ev.convId, ref, true);
        if (live && ev.author !== self) {
          const body = JSON.parse(row.bodyJson) as { replyTo?: MsgRef; thread?: MsgRef };
          const fresh = this.messages.get(ev.convId, ref)!;
          if (fresh.mentionsMe) this.activity(fx, 'mention', ev, ref, '');
          // A quoted reply to my message, or a reply in the thread of my post.
          if (body.replyTo?.author === self || body.thread?.author === self)
            this.activity(fx, 'reply', ev, ref, '');
          fx.incoming.push({ convId: ev.convId, row: fresh });
        }
        return;
      }
      case 'msg.edit': {
        const body = MsgEditBody.safeParse(ev.body);
        // Edits and deletes are valid only from the original author (plan section 8, rule 3).
        if (!body.success || body.data.target.author !== ev.author) return;
        const current = this.messages.get(ev.convId, body.data.target);
        if (!current) return; // applied when the post arrives
        const meta = { ...(JSON.parse(current.bodyJson) as Record<string, unknown>) };
        if (body.data.mentions) meta['mentions'] = body.data.mentions;
        else delete meta['mentions'];
        const mentionsMe = body.data.mentions?.includes(self) ?? false;
        const plain = this.plainFor(current.kind, body.data.text, meta);
        if (
          this.messages.edit(
            ev.convId,
            body.data.target,
            body.data.text,
            plain,
            JSON.stringify(meta),
            mentionsMe,
            ev.hlc,
          )
        ) {
          touch(fx, ev.convId, body.data.target);
        }
        return;
      }
      case 'msg.delete': {
        const body = MsgDeleteBody.safeParse(ev.body);
        if (!body.success || body.data.target.author !== ev.author) return;
        if (this.messages.markDeleted(ev.convId, body.data.target))
          touch(fx, ev.convId, body.data.target);
        return;
      }
      case 'msg.react':
      case 'msg.unreact': {
        const body = MsgReactBody.safeParse(ev.body);
        if (!body.success) return;
        const present = ev.type === 'msg.react';
        if (
          !this.messages.setReaction(
            ev.convId,
            body.data.target,
            ev.author,
            body.data.emoji,
            present,
            ev.hlc,
          )
        )
          return;
        touch(fx, ev.convId, body.data.target);
        if (live && present && ev.author !== self && body.data.target.author === self) {
          this.activity(fx, 'reaction', ev, body.data.target, body.data.emoji);
        }
        return;
      }
      case 'msg.pin':
      case 'msg.unpin': {
        const body = MsgPinBody.safeParse(ev.body);
        if (!body.success) return;
        if (
          this.messages.setPin(
            ev.convId,
            body.data.target,
            ev.type === 'msg.pin',
            ev.author,
            ev.hlc,
          )
        ) {
          touch(fx, ev.convId, body.data.target);
        }
        return;
      }
      case 'msg.read': {
        const body = MsgReadBody.safeParse(ev.body);
        if (!body.success || ev.author === self) return;
        const prev = this.messages.raiseReceipt(ev.convId, ev.author, body.data.upto);
        if (!prev) return;
        // Own messages the reader has now seen change status to "Seen".
        for (const row of this.messages.byAuthorInHlcRange(ev.convId, self, prev, body.data.upto)) {
          touch(fx, ev.convId, { author: row.author, seq: row.seq });
        }
        return;
      }
      case 'poll.vote': {
        const body = PollVoteBody.safeParse(ev.body);
        if (!body.success) return;
        const poll = this.messages.get(ev.convId, body.data.target);
        if (poll && poll.kind !== 'poll') return;
        if (
          this.messages.setVote(
            ev.convId,
            body.data.target,
            ev.author,
            [...new Set(body.data.choices)],
            ev.hlc,
          )
        ) {
          touch(fx, ev.convId, body.data.target);
        }
        return;
      }
      case 'poll.close': {
        const body = PollCloseBody.safeParse(ev.body);
        // Only the poll's author may close it.
        if (!body.success || body.data.target.author !== ev.author) return;
        if (this.messages.closePoll(ev.convId, body.data.target, ev.hlc))
          touch(fx, ev.convId, body.data.target);
        return;
      }
      default:
        // Membership, control and unknown types are kept in the log but not shown here.
        return;
    }
  }

  private plainFor(
    kind: 'text' | 'file' | 'poll',
    text: string,
    meta: Record<string, unknown>,
  ): string {
    const plain = toPlain(text);
    if (kind === 'poll')
      return [text, ...((meta['options'] as string[] | undefined) ?? [])].join(' ');
    const file = meta['file'] as { name?: string } | undefined;
    return kind === 'file' && file?.name ? `${file.name}\n${plain}`.trim() : plain;
  }

  private postRow(ev: LogEvent): MessageRow | undefined {
    const parsed =
      ev.type === 'msg.post'
        ? MsgPostBody.safeParse(ev.body)
        : ev.type === 'poll.create'
          ? PollCreateBody.safeParse(ev.body)
          : FileShareBody.safeParse(ev.body);
    if (!parsed.success) return undefined;
    const data = parsed.data as Record<string, unknown>;
    // A poll's question is its text; everything else stays in the body.
    const {
      text = '',
      question,
      ...meta
    } = data as { text?: string; question?: string } & Record<string, unknown>;
    const kind = ev.type === 'file.share' ? 'file' : ev.type === 'poll.create' ? 'poll' : 'text';
    const shown = kind === 'poll' ? (question ?? '') : text;
    const thread = meta['thread'] as MsgRef | undefined;
    const mentions = (meta['mentions'] as string[] | undefined) ?? [];
    return {
      convId: ev.convId,
      author: ev.author,
      seq: ev.seq,
      hlcT: ev.hlc.t,
      hlcC: ev.hlc.c,
      kind,
      text: shown,
      plain: this.plainFor(kind, shown, meta),
      bodyJson: JSON.stringify(meta),
      editedT: null,
      editedC: null,
      deleted: 0,
      mentionsMe: mentions.includes(this.selfId) ? 1 : 0,
      urgent: meta['urgent'] === true ? 1 : 0,
      threadAuthor: thread?.author ?? null,
      threadSeq: thread?.seq ?? null,
    };
  }

  private activity(
    fx: Effects,
    kind: 'mention' | 'reply' | 'reaction',
    ev: LogEvent,
    target: MsgRef,
    emoji: string,
  ): void {
    const id = this.messages.addActivity({
      kind,
      convId: ev.convId,
      author: ev.author,
      targetAuthor: target.author,
      targetSeq: target.seq,
      sourceSeq: ev.seq,
      emoji,
      at: ev.hlc.t,
    });
    if (id !== undefined) fx.activity.push({ id, convId: ev.convId });
  }
}
