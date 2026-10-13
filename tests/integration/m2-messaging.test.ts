import { afterEach, describe, expect, it } from 'vitest';
import { signRecord, type Core, type Toast } from '@officemesh/core';
import { FakeClock } from '@officemesh/core/testing';
import { startInProcessPeers, type InProcessSim } from '@officemesh/sim';
import type { MessageView } from '@officemesh/protocol/ipc';
import { allKnowEachOther, person, run, settle, until } from './helpers.ts';

const sims: InProcessSim[] = [];
afterEach(async () => {
  for (const s of sims.splice(0)) await s.stop();
});

async function lan(count: number) {
  const clock = new FakeClock();
  const sim = await startInProcessPeers({ count, clock });
  sims.push(sim);
  const core = (i: number) => sim.peers[i]!.core;
  await until(clock, () => allKnowEachOther(sim.peers.filter(Boolean).map((p) => p.core)), 10_000);
  return { clock, sim, core };
}

/** The parts of a message both sides must agree on. */
function shared(m: MessageView) {
  return {
    id: m.id,
    text: m.text,
    mentions: m.mentions,
    urgent: m.urgent,
    edited: m.edited,
    deleted: m.deleted,
    pinned: m.pinned,
    replyTo: m.replyTo && { author: m.replyTo.author, seq: m.replyTo.seq },
    forwarded: m.forwarded,
    reactions: m.reactions.map((r) => ({ emoji: r.emoji, users: [...r.users].sort() })),
  };
}

const sameView = (a: Core, b: Core, convId: string) =>
  JSON.stringify(a.listMessages(convId, 500).map(shared)) ===
  JSON.stringify(b.listMessages(convId, 500).map(shared));

/** Every message action, performed by both people (letting deliveries land in between). */
async function everyAction(alice: Core, bob: Core, convId: string) {
  const a1 = alice.sendMessage(
    convId,
    `Hi @[Bob](${bob.userId}), **draft** is ready: \`report.xlsx\``,
  );
  await settle();
  const b1 = bob.sendMessage(convId, 'Thanks! I will check', {
    replyTo: { author: a1.author, seq: a1.seq },
  });
  await settle();
  const a2 = alice.sendMessage(convId, 'Server room door is open', { urgent: true });
  const a3 = alice.sendMessage(convId, 'tpyo here');
  alice.editMessage(convId, a3, 'typo fixed here');
  const a4 = alice.sendMessage(convId, 'sent by mistake');
  alice.deleteMessage(convId, a4);
  await settle();
  bob.react(convId, a1, '👍', true);
  bob.react(convId, a1, '❤️', true);
  bob.react(convId, a1, '❤️', false);
  alice.react(convId, b1, '😆', true);
  bob.pin(convId, a2, true);
  alice.pin(convId, a1, true);
  alice.pin(convId, a1, false);
  return { a1, b1, a2, a3, a4 };
}

describe('M2 message actions', () => {
  it('every action round-trips between two online peers', async () => {
    const { clock, core } = await lan(2);
    const [alice, bob] = [core(0), core(1)];
    const conv = alice.openDirect(bob.userId).convId;
    bob.openDirect(alice.userId);
    const ids = await everyAction(alice, bob, conv);
    await run(clock, 1_000);

    expect(sameView(alice, bob, conv)).toBe(true);
    const onBob = Object.fromEntries(bob.listMessages(conv).map((m) => [m.id, m]));
    const id = (r: { author: string; seq: number }) => `${r.author}:${r.seq}`;
    expect(onBob[id(ids.a1)]).toMatchObject({
      mentionsMe: true,
      mentions: [bob.userId],
      pinned: false,
    });
    expect(onBob[id(ids.a1)]!.reactions).toEqual([
      { emoji: '👍', users: [bob.userId], mine: true },
    ]);
    expect(onBob[id(ids.b1)]!.replyTo).toMatchObject({
      author: alice.userId,
      seq: ids.a1.seq,
      missing: false,
    });
    expect(onBob[id(ids.b1)]!.replyTo!.excerpt).toContain('draft is ready');
    expect(onBob[id(ids.a2)]).toMatchObject({ urgent: true, pinned: true });
    expect(onBob[id(ids.a3)]).toMatchObject({ text: 'typo fixed here', edited: true });
    expect(onBob[id(ids.a4)]).toMatchObject({ deleted: true, text: '' });
    expect(bob.pinnedMessages(conv).map((m) => m.id)).toEqual([id(ids.a2)]);

    // Saved messages are private to the PC that saved them.
    bob.save(conv, ids.a2, true);
    expect(bob.savedMessages().map((m) => m.id)).toEqual([id(ids.a2)]);
    expect(alice.savedMessages()).toEqual([]);

    // Forward to a third person.
    const carol = (await sims[0]!.startPeer(2)).core;
    await until(clock, () => person(alice, carol.userId)?.displayName !== undefined, 10_000);
    const toCarol = alice.openDirect(carol.userId).convId;
    alice.forward(conv, ids.b1, toCarol);
    await run(clock, 1_000);
    expect(carol.listMessages(toCarol)[0]).toMatchObject({
      text: 'Thanks! I will check',
      forwarded: { from: bob.identity.profile.displayName },
    });
  });

  it('every action round-trips after an offline gap', async () => {
    const { clock, sim, core } = await lan(2);
    const [alice, bobId] = [core(0), core(1).userId];
    const conv = alice.openDirect(bobId).convId;
    const before = alice.sendMessage(conv, 'before the gap');
    await run(clock, 500);
    const bobRef = core(1).sendMessage(conv, 'bob was here');
    await run(clock, 500);

    await sim.stopPeer(1);
    await until(clock, () => person(alice, bobId)?.online === false, 2_000);
    const a1 = alice.sendMessage(conv, `offline note for @[Bob](${bobId})`);
    alice.editMessage(conv, before, 'before the gap (edited)');
    alice.react(conv, bobRef, '🎉', true);
    alice.pin(conv, bobRef, true);
    const gone = alice.sendMessage(conv, 'oops');
    alice.deleteMessage(conv, gone);
    void a1;

    await sim.startPeer(1);
    await until(clock, () => sameView(alice, core(1), conv), 15_000);
    const onBob = core(1).listMessages(conv);
    expect(onBob.find((m) => m.text === 'before the gap (edited)')?.edited).toBe(true);
    expect(onBob.find((m) => m.text === 'bob was here')).toMatchObject({
      pinned: true,
      reactions: [{ emoji: '🎉' }],
    });
    expect(onBob.find((m) => m.id === `${gone.author}:${gone.seq}`)?.deleted).toBe(true);
    expect(
      core(1)
        .activity()
        .map((a) => a.kind)
        .sort(),
    ).toEqual(['mention', 'reaction']);
  });

  it('ignores edits and deletes by anyone but the author, and rebuild reproduces every table', async () => {
    const { clock, core } = await lan(2);
    const [alice, bob] = [core(0), core(1)];
    const conv = alice.openDirect(bob.userId).convId;
    await everyAction(alice, bob, conv);
    const target = alice.sendMessage(conv, 'only Alice may change this');
    await run(clock, 500);
    // Bob signs an edit and a delete of Alice's message (valid member, wrong author).
    const forge = (type: string, body: object, seq: number) =>
      signRecord(bob.identity.privateKey, {
        convId: conv,
        author: bob.userId,
        seq,
        hlc: { t: clock.now(), c: 0 },
        type,
        body,
      });
    const head = bob.conversations.head(conv, bob.userId);
    bob.network!.links.send(alice.userId, 'event.push', {
      event: forge('msg.edit', { target, text: 'Bob was here' }, head + 1),
    });
    bob.network!.links.send(alice.userId, 'event.push', {
      event: forge('msg.delete', { target }, head + 2),
    });
    await run(clock, 500);
    expect(
      alice.listMessages(conv).find((m) => m.id === `${target.author}:${target.seq}`)?.text,
    ).toBe('only Alice may change this');

    for (const c of [alice, bob]) {
      const before = c.messages.dump();
      c.rebuild();
      expect(c.messages.dump()).toBe(before);
    }
  });

  it('read receipts turn Delivered into Seen, and typing reaches the other side', async () => {
    const { clock, core } = await lan(2);
    const [alice, bob] = [core(0), core(1)];
    const conv = alice.openDirect(bob.userId).convId;
    const typing: string[] = [];
    bob.onEvent((name, p) => name === 'typing' && typing.push((p as { userId: string }).userId));
    const sent = alice.sendMessage(conv, 'did you see this?');
    await run(clock, 300);
    alice.sendTyping(conv);
    await settle();
    expect(typing).toEqual([alice.userId]);
    expect(alice.listMessages(conv)[0]?.status).toBe('delivered');
    bob.setUiState({ activeConvId: conv, windowFocused: true });
    await run(clock, 3_000);
    expect(alice.listMessages(conv).find((m) => m.seq === sent.seq)?.status).toBe('read');
    expect(bob.conversationList()[0]?.unread).toBe(0);

    // With receipts off, Bob's reading is not reported.
    bob.setSettings({ readReceipts: false });
    bob.setUiState({ activeConvId: null, windowFocused: false });
    const second = alice.sendMessage(conv, 'and this?');
    await run(clock, 300);
    bob.setUiState({ activeConvId: conv, windowFocused: true });
    await run(clock, 3_000);
    expect(alice.listMessages(conv).find((m) => m.seq === second.seq)?.status).toBe('delivered');
  });
});

describe('M2 notifications and activity', () => {
  it('toasts direct messages, honours viewing, mute and Do not disturb, and replies from the toast', async () => {
    const clock = new FakeClock();
    const toasts: Toast[] = [];
    const badges: number[] = [];
    const sim = await startInProcessPeers({ count: 2, clock });
    sims.push(sim);
    // Give Bob's core a host that records toasts and badges.
    const bob = sim.peers[1]!.core;
    (bob as unknown as { options: { host: object } }).options.host = {
      fixFirewall: async () => {},
      openNetworkSettings: () => {},
      notify: (t: Toast) => toasts.push(t),
      setBadge: (n: number) => badges.push(n),
    };
    const alice = sim.peers[0]!.core;
    await until(clock, () => allKnowEachOther([alice, bob]), 10_000);
    const conv = alice.openDirect(bob.userId).convId;

    alice.sendMessage(conv, 'Lunch?');
    await run(clock, 300);
    expect(toasts.map((t) => t.body)).toEqual(['Lunch?']);
    expect(badges.at(-1)).toBe(1);

    bob.setUiState({ activeConvId: conv, windowFocused: true });
    alice.sendMessage(conv, 'seen while open');
    await run(clock, 300);
    expect(toasts).toHaveLength(1);
    expect(badges.at(-1)).toBe(0);
    bob.setUiState({ activeConvId: null, windowFocused: false });

    bob.setPresence('dnd');
    alice.sendMessage(conv, 'not urgent');
    alice.sendMessage(conv, 'fire drill now', { urgent: true });
    await run(clock, 300);
    expect(toasts.map((t) => t.title)).toEqual([
      expect.any(String),
      expect.stringMatching(/^URGENT: /),
    ]);

    bob.setPresence('available');
    bob.setNotifyLevel(conv, 'muted');
    alice.sendMessage(conv, 'muted chat');
    await run(clock, 300);
    expect(toasts).toHaveLength(2);

    // Inline reply from the toast posts without the window.
    bob.replyFromToast(conv, 'On my way');
    await run(clock, 300);
    expect(alice.listMessages(conv).at(-1)).toMatchObject({ text: 'On my way', mine: false });

    // Windows can hand one typed reply over twice: that is still one message ...
    const thanks = () => alice.listMessages(conv).filter((m) => m.text === 'Thanks');
    bob.replyFromToast(conv, 'Thanks');
    bob.replyFromToast(conv, 'Thanks');
    await run(clock, 300);
    expect(thanks()).toHaveLength(1);
    // ... a different reply right after is its own message, and the same words later are too.
    bob.replyFromToast(conv, 'Thanks again');
    await run(clock, 6_000);
    bob.replyFromToast(conv, 'Thanks');
    await run(clock, 300);
    expect(thanks()).toHaveLength(2);
  });

  it('lists mentions, replies and reactions in Activity', async () => {
    const { clock, core } = await lan(2);
    const [alice, bob] = [core(0), core(1)];
    const conv = alice.openDirect(bob.userId).convId;
    bob.openDirect(alice.userId);
    const mine = bob.sendMessage(conv, 'my idea');
    await run(clock, 300);
    alice.sendMessage(conv, `@[Bob](${bob.userId}) look at this`);
    alice.sendMessage(conv, 'agreed', { replyTo: mine });
    alice.react(conv, mine, '👏', true);
    await run(clock, 300);
    const items = bob.activity();
    expect(items.map((i) => i.kind).sort()).toEqual(['mention', 'reaction', 'reply']);
    expect(items.find((i) => i.kind === 'reaction')).toMatchObject({
      emoji: '👏',
      target: { author: mine.author, seq: mine.seq },
      excerpt: 'my idea',
    });
    bob.markActivityRead();
    expect(bob.activity().every((i) => i.read)).toBe(true);
  });
});

describe('M2 search', () => {
  it('finds a hit among 100,000 stored messages in under 200 ms', async () => {
    const { core } = await lan(1);
    const me = core(0);
    const words = [
      'invoice',
      'meeting',
      'printer',
      'lunch',
      'budget',
      'server',
      'holiday',
      'report',
      'client',
      'deadline',
    ];
    const convId = 'a'.repeat(32);
    me.conversations.createDirect(convId, me.userId, 'b'.repeat(32), 0);
    me.store.db.transaction(() => {
      for (let i = 1; i <= 100_000; i++) {
        const text = `${words[i % 10]} ${words[(i * 7) % 10]} note ${i}`;
        me.messages.insert({
          convId,
          author: 'b'.repeat(32),
          seq: i,
          hlcT: 1_000 + i,
          hlcC: 0,
          kind: 'text',
          text,
          plain: text,
          bodyJson: '{}',
          editedT: null,
          editedC: null,
          deleted: 0,
          mentionsMe: 0,
          urgent: 0,
          threadAuthor: null,
          threadSeq: null,
        });
      }
      const special = 'The quarterly zeppelin forecast is attached';
      me.messages.insert({
        convId,
        author: 'b'.repeat(32),
        seq: 100_001,
        hlcT: 500,
        hlcC: 0,
        kind: 'text',
        text: special,
        plain: special,
        bodyJson: '{}',
        editedT: null,
        editedC: null,
        deleted: 0,
        mentionsMe: 0,
        urgent: 0,
        threadAuthor: null,
        threadSeq: null,
      });
    })();
    me.search({ text: 'warm up' });
    const t0 = performance.now();
    const res = me.search({ text: 'zeppel' });
    const took = performance.now() - t0;
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0]!.snippet).toContain('\u0001zeppelin\u0002');
    expect(took).toBeLessThan(200);
    // A common word with filters stays fast too.
    const t1 = performance.now();
    const common = me.search({ text: 'meeting note', limit: 50 });
    expect(performance.now() - t1).toBeLessThan(200);
    expect(common.messages).toHaveLength(50);
    console.info(
      `search over 100,001 messages: rare word ${took.toFixed(1)} ms, common words ${common.tookMs.toFixed(1)} ms`,
    );
  });
});
