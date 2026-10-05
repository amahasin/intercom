import {
  FileShareBody,
  MsgDeleteBody,
  MsgEditBody,
  MsgPinBody,
  MsgPostBody,
  MsgReactBody,
  MsgReadBody,
  CallEndedBody,
  CallStartedBody,
  MAX_MEETING_MS,
  MeetingCancelBody,
  MeetingRsvpBody,
  MeetingScheduleBody,
  MeetingUpdateBody,
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

/** A meeting must end after it starts and last at most a day. */
function validMeeting(m: { start: number; end: number }): boolean {
  return m.end > m.start && m.end - m.start <= MAX_MEETING_MS;
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
      case 'poll.create':
      case 'meeting.schedule':
      case 'call.started': {
        const row = this.postRow(ev);
        if (!row || !this.messages.insert(row)) return;
        // Pick up edits and deletes that arrived before the post did.
        for (const json of this.conversations.targeting(ev.convId, ref, [
          'msg.edit',
          'msg.delete',
          'meeting.update',
          'meeting.cancel',
          'call.ended',
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
        if (current.kind !== 'text' && current.kind !== 'file') return;
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
      case 'meeting.update': {
        const body = MeetingUpdateBody.safeParse(ev.body);
        // Only the organiser (the meeting's author) changes it.
        if (!body.success || body.data.target.author !== ev.author) return;
        const { target, ...fields } = body.data;
        if (!validMeeting(fields)) return;
        const current = this.messages.get(ev.convId, target);
        if (!current || current.kind !== 'meeting') return; // applied when the meeting arrives
        const { title, ...meta } = fields;
        if (
          this.messages.edit(
            ev.convId,
            target,
            title,
            this.plainFor('meeting', title, meta),
            JSON.stringify(meta),
            false,
            ev.hlc,
          )
        ) {
          touch(fx, ev.convId, target);
        }
        return;
      }
      case 'meeting.cancel': {
        const body = MeetingCancelBody.safeParse(ev.body);
        if (!body.success || body.data.target.author !== ev.author) return;
        if (this.messages.cancelMeeting(ev.convId, body.data.target, body.data.occurrence ?? 0)) {
          touch(fx, ev.convId, body.data.target);
        }
        return;
      }
      case 'meeting.rsvp': {
        const body = MeetingRsvpBody.safeParse(ev.body);
        if (!body.success) return;
        const meeting = this.messages.get(ev.convId, body.data.target);
        if (meeting && meeting.kind !== 'meeting') return;
        if (
          this.messages.setRsvp(ev.convId, body.data.target, ev.author, body.data.response, ev.hlc)
        ) {
          touch(fx, ev.convId, body.data.target);
        }
        return;
      }
      case 'call.ended': {
        const body = CallEndedBody.safeParse(ev.body);
        if (!body.success) return;
        const card = this.messages.get(ev.convId, body.data.target);
        if (!card || card.kind !== 'call') return; // applied when the card arrives
        if (this.messages.markCallEnded(ev.convId, body.data.target))
          touch(fx, ev.convId, body.data.target);
        return;
      }
      default:
        // Membership, control and unknown types are kept in the log but not shown here.
        return;
    }
  }

  private plainFor(kind: MessageRow['kind'], text: string, meta: Record<string, unknown>): string {
    if (kind === 'call') return 'Meeting started';
    if (kind === 'meeting')
      return [text, (meta['notes'] as string | undefined) ?? ''].join(' ').trim();
    const plain = toPlain(text);
    if (kind === 'poll')
      return [text, ...((meta['options'] as string[] | undefined) ?? [])].join(' ');
    const file = meta['file'] as { name?: string } | undefined;
    return kind === 'file' && file?.name ? `${file.name}\n${plain}`.trim() : plain;
  }

  private postRow(ev: LogEvent): MessageRow | undefined {
    const schema = {
      'msg.post': MsgPostBody,
      'poll.create': PollCreateBody,
      'file.share': FileShareBody,
      'meeting.schedule': MeetingScheduleBody,
      'call.started': CallStartedBody,
    }[ev.type as 'msg.post'];
    const parsed = schema?.safeParse(ev.body);
    if (!parsed?.success) return undefined;
    const data = parsed.data as Record<string, unknown>;
    if (ev.type === 'meeting.schedule' && !validMeeting(data as MeetingScheduleBody))
      return undefined;
    // A poll's question and a meeting's title are its text; everything else stays in the body.
    const {
      text = '',
      question,
      title,
      ...meta
    } = data as { text?: string; question?: string; title?: string } & Record<string, unknown>;
    const kind: MessageRow['kind'] =
      ev.type === 'file.share'
        ? 'file'
        : ev.type === 'poll.create'
          ? 'poll'
          : ev.type === 'meeting.schedule'
            ? 'meeting'
            : ev.type === 'call.started'
              ? 'call'
              : 'text';
    const shown = kind === 'poll' ? (question ?? '') : kind === 'meeting' ? (title ?? '') : text;
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
