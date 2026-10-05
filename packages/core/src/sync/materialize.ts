import {
  FileShareBody,
  MsgDeleteBody,
  MsgEditBody,
  MsgPinBody,
  MsgPostBody,
  MsgReactBody,
  MsgReadBody,
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

  constructor(selfId: string, messages: MessageRepo, conversations: ConversationRepo) {
    this.selfId = selfId;
    this.messages = messages;
    this.conversations = conversations;
  }

  /** `live` adds activity items and notification candidates; rebuild leaves them alone. */
  apply(ev: LogEvent, live: boolean, fx: Effects): void {
    const self = this.selfId;
    const ref = { author: ev.author, seq: ev.seq };
    switch (ev.type) {
      case 'msg.post':
      case 'file.share': {
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
          const body = JSON.parse(row.bodyJson) as { replyTo?: MsgRef };
          const fresh = this.messages.get(ev.convId, ref)!;
          if (fresh.mentionsMe) this.activity(fx, 'mention', ev, ref, '');
          if (body.replyTo?.author === self) this.activity(fx, 'reply', ev, ref, '');
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
      default:
        // Unknown or not-yet-implemented types are kept in the log but not shown.
        return;
    }
  }

  private plainFor(kind: 'text' | 'file', text: string, meta: Record<string, unknown>): string {
    const plain = toPlain(text);
    const file = meta['file'] as { name?: string } | undefined;
    return kind === 'file' && file?.name ? `${file.name}\n${plain}`.trim() : plain;
  }

  private postRow(ev: LogEvent): MessageRow | undefined {
    const parsed =
      ev.type === 'msg.post' ? MsgPostBody.safeParse(ev.body) : FileShareBody.safeParse(ev.body);
    if (!parsed.success) return undefined;
    const { text = '', ...meta } = parsed.data as { text?: string } & Record<string, unknown>;
    const kind = ev.type === 'file.share' ? 'file' : 'text';
    const mentions = (meta['mentions'] as string[] | undefined) ?? [];
    return {
      convId: ev.convId,
      author: ev.author,
      seq: ev.seq,
      hlcT: ev.hlc.t,
      hlcC: ev.hlc.c,
      kind,
      text,
      plain: this.plainFor(kind, text, meta),
      bodyJson: JSON.stringify(meta),
      editedT: null,
      editedC: null,
      deleted: 0,
      mentionsMe: mentions.includes(this.selfId) ? 1 : 0,
      urgent: meta['urgent'] === true ? 1 : 0,
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
