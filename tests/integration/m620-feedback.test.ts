import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Core } from '@officemesh/core';
import { MIGRATIONS, Store } from '@officemesh/core';
import { EMAIL_PATTERN, MAX_NOTES, ProfileEdit } from '@officemesh/protocol';
import { FakeClock } from '@officemesh/core/testing';
import { startInProcessPeers, type InProcessSim } from '@officemesh/sim';
import { EMAIL_RE, NOTES_MAX } from '../../apps/desktop/renderer/src/format.ts';
import { allKnowEachOther, run, until } from './helpers.ts';

const sims: InProcessSim[] = [];
afterEach(async () => {
  for (const s of sims.splice(0)) await s.stop();
});

async function lan(count: number) {
  const clock = new FakeClock();
  const sim = await startInProcessPeers({ count, clock });
  sims.push(sim);
  const cores = sim.peers.map((p) => p.core) as Core[];
  await until(clock, () => allKnowEachOther(cores), 20_000);
  return { clock, cores };
}

describe('M6.20 reactions in Activity: one entry for each person and message', () => {
  it('follows what the person has on the message now', async () => {
    const { clock, cores } = await lan(2);
    const [alice, bob] = cores as [Core, Core];
    const conv = alice.openDirect(bob.userId).convId;
    bob.openDirect(alice.userId);
    const mine = bob.sendMessage(conv, 'my idea');
    await run(clock, 300);
    const reactions = () => bob.activity().filter((i) => i.kind === 'reaction');

    // A reaction is one entry.
    alice.react(conv, mine, '😡', true);
    await run(clock, 300);
    expect(reactions()).toHaveLength(1);
    expect(reactions()[0]).toMatchObject({ emoji: '😡', read: false });
    bob.markActivityRead();
    expect(reactions()[0]!.read).toBe(true);

    // Trying other reactions on the same message (the person changes their mind) is still one
    // entry, with what they have on it now, and it is new to Bob again.
    alice.react(conv, mine, '😡', false);
    alice.react(conv, mine, '😮', true);
    await run(clock, 300);
    expect(reactions()).toHaveLength(1);
    expect(reactions()[0]).toMatchObject({ emoji: '😮', read: false });
    bob.markActivityRead();
    alice.react(conv, mine, '❤', true);
    await run(clock, 300);
    expect(reactions()).toHaveLength(1);
    expect(reactions()[0]!.emoji!.split(' ').sort()).toEqual(['❤', '😮'].sort());
    expect(reactions()[0]!.read).toBe(false);

    // Taking one off changes what is shown, but it is not news: it stays as read as it was.
    bob.markActivityRead();
    alice.react(conv, mine, '❤', false);
    await run(clock, 300);
    expect(reactions()[0]).toMatchObject({ emoji: '😮', read: true });

    // Taking the last one off removes the entry (and the unread count with it).
    alice.react(conv, mine, '😮', true);
    alice.react(conv, mine, '😮', false);
    alice.react(conv, mine, '😮', false);
    await run(clock, 300);
    expect(reactions()).toHaveLength(0);
    expect(bob.activity().filter((i) => !i.read)).toHaveLength(0);
  });

  it("keeps people and messages apart, and ignores the user's own reactions", async () => {
    const { clock, cores } = await lan(3);
    const [alice, bob, carol] = cores as [Core, Core, Core];
    const group = alice.createGroup([bob.userId, carol.userId], 'Crit').convId;
    await run(clock, 2_000);
    const first = bob.sendMessage(group, 'first');
    const second = bob.sendMessage(group, 'second');
    await run(clock, 500);
    alice.react(group, first, '👍', true);
    carol.react(group, first, '👍', true);
    alice.react(group, second, '👍', true);
    // Bob reacting to his own message is not news to him.
    bob.react(group, first, '🎉', true);
    await run(clock, 500);
    const entries = bob.activity().filter((i) => i.kind === 'reaction');
    expect(entries).toHaveLength(3);
    expect(new Set(entries.map((e) => `${e.author}:${e.target?.seq}`)).size).toBe(3);
    // One person's change does not touch another's entry.
    alice.react(group, first, '👍', false);
    await run(clock, 500);
    expect(bob.activity().filter((i) => i.kind === 'reaction')).toHaveLength(2);
  });
});

const personOf = (viewer: Core, userId: string) =>
  viewer.people().find((p) => p.userId === userId)!;

describe('M6.20 an email address and notes on the profile', () => {
  it('are kept tidy, reach colleagues, and can be cleared', async () => {
    const { clock, cores } = await lan(2);
    const [alice, bob] = cores as [Core, Core];
    alice.openDirect(bob.userId);
    await run(clock, 1_000);

    const view = alice.updateProfile({
      email: ' alice@office.com ',
      notes: 'In Mon-Thu.\r\nAsk me about the printers.  \r\n',
    });
    // Lines end the same way on every PC; the ends are trimmed.
    expect(view.email).toBe('alice@office.com');
    expect(view.notes).toBe('In Mon-Thu.\nAsk me about the printers.');

    await until(clock, () => personOf(bob, alice.userId).email === 'alice@office.com', 20_000);
    expect(personOf(bob, alice.userId).notes).toBe('In Mon-Thu.\nAsk me about the printers.');

    // Empty clears them.
    const cleared = alice.updateProfile({ email: '', notes: '' });
    expect(cleared.email).toBeUndefined();
    expect(cleared.notes).toBeUndefined();
    await until(clock, () => personOf(bob, alice.userId).email === undefined, 20_000);
    expect(personOf(bob, alice.userId).notes).toBeUndefined();
  });

  it('refuses something that is not an address, and the page uses the same rules', () => {
    expect(ProfileEdit.safeParse({ email: 'nope' }).success).toBe(false);
    expect(ProfileEdit.safeParse({ email: 'a b@c.com' }).success).toBe(false);
    expect(ProfileEdit.safeParse({ email: '' }).success).toBe(true);
    expect(ProfileEdit.safeParse({ email: ' ali@company.com ' }).success).toBe(true);
    expect(ProfileEdit.safeParse({ notes: 'x'.repeat(MAX_NOTES + 1) }).success).toBe(false);
    // The window checks as it types; it must agree with what the core will accept.
    expect(NOTES_MAX).toBe(MAX_NOTES);
    expect(EMAIL_RE.source).toBe(EMAIL_PATTERN.source);
  });
});

describe('M6.20 message details: when it reached each person and when it was seen', () => {
  it('a chat of two: delivered, then seen, each with its time', async () => {
    const { clock, cores } = await lan(2);
    const [alice, bob] = cores as [Core, Core];
    const conv = alice.openDirect(bob.userId).convId;
    bob.openDirect(alice.userId);
    await run(clock, 500);
    const before = clock.now();
    const sent = alice.sendMessage(conv, 'are you there?');
    await run(clock, 300);

    const delivered = alice.messageDetails(conv, sent);
    expect(delivered.sentAt).toBeGreaterThanOrEqual(before);
    expect(delivered.recipients).toHaveLength(1);
    const first = delivered.recipients![0]!;
    expect(first).toMatchObject({ userId: bob.userId, delivered: true, seen: false });
    expect(first.deliveredAt).toBeGreaterThanOrEqual(delivered.sentAt);
    expect(first.deliveredAt).toBeLessThanOrEqual(clock.now());
    expect(first.seenAt).toBeUndefined();

    bob.setUiState({ activeConvId: conv, windowFocused: true });
    await run(clock, 3_000);
    const seen = alice.messageDetails(conv, sent).recipients![0]!;
    expect(seen).toMatchObject({ delivered: true, seen: true });
    expect(seen.seenAt).toBeGreaterThanOrEqual(seen.deliveredAt!);

    // The other side only has what the sender knows: no delivery times for a received message.
    expect(bob.messageDetails(conv, sent).recipients).toBeUndefined();
    expect(bob.messageDetails(conv, sent).sentAt).toBe(delivered.sentAt);
  });

  it('a message from before the times were kept is still known to be delivered', async () => {
    const { clock, cores } = await lan(2);
    const [alice, bob] = cores as [Core, Core];
    const conv = alice.openDirect(bob.userId).convId;
    bob.openDirect(alice.userId);
    await run(clock, 500);
    const sent = alice.sendMessage(conv, 'old news');
    await run(clock, 300);
    alice.store.db.prepare('DELETE FROM ack_log').run();
    const r = alice.messageDetails(conv, sent).recipients![0]!;
    expect(r.delivered).toBe(true);
    expect(r.deliveredAt).toBeUndefined();
  });

  it('a group: who has it so far, who has seen it, and when', async () => {
    const clock = new FakeClock();
    const sim = await startInProcessPeers({ count: 3, clock });
    sims.push(sim);
    const [alice, bob, carol] = sim.peers.map((p) => p.core) as [Core, Core, Core];
    await until(clock, () => allKnowEachOther([alice, bob, carol]), 20_000);
    const group = alice.createGroup([bob.userId, carol.userId], 'Crit').convId;
    await run(clock, 2_000);

    // Carol's PC is off the network when the message goes out.
    sim.unplug(2);
    await run(clock, 500);
    const sent = alice.sendMessage(group, 'review at 3');
    await run(clock, 500);
    const sentAt = alice.messageDetails(group, sent).sentAt;
    const byId = () =>
      Object.fromEntries(alice.messageDetails(group, sent).recipients!.map((r) => [r.userId, r]));
    expect(byId()[bob.userId]).toMatchObject({ delivered: true, seen: false });
    expect(byId()[carol.userId]).toMatchObject({ delivered: false, seen: false });
    expect(byId()[carol.userId]!.deliveredAt).toBeUndefined();

    // Bob looks at it.
    bob.setUiState({ activeConvId: group, windowFocused: true });
    await run(clock, 3_000);
    expect(byId()[bob.userId]).toMatchObject({ delivered: true, seen: true });
    expect(byId()[bob.userId]!.seenAt).toBeGreaterThanOrEqual(sentAt);
    expect(byId()[carol.userId]).toMatchObject({ delivered: false, seen: false });

    // Carol's PC comes back: it is delivered then, later than Bob's, and still not seen.
    const bobDeliveredAt = byId()[bob.userId]!.deliveredAt!;
    sim.replug(2);
    await until(clock, () => byId()[carol.userId]!.delivered, 120_000);
    expect(byId()[carol.userId]!.deliveredAt).toBeGreaterThan(bobDeliveredAt);
    expect(byId()[carol.userId]!.seen).toBe(false);
  });
});

describe('M6.20 Remote Desktop use of a PC is told to colleagues', () => {
  it('shows who is connected, from where, and when they leave', async () => {
    let sessions: Array<{ state: 'active' | 'disconnected'; client?: string; address?: string }> =
      [];
    const clock = new FakeClock();
    const sim = await startInProcessPeers({
      count: 2,
      clock,
      coreOptions: (index) =>
        index === 0
          ? {
              host: {
                fixFirewall: async () => {},
                openNetworkSettings: () => {},
                remoteSessions: async () => sessions,
              },
            }
          : {},
    });
    sims.push(sim);
    const [alice, bob] = sim.peers.map((p) => p.core) as [Core, Core];
    await until(clock, () => allKnowEachOther([alice, bob]), 20_000);
    bob.openDirect(alice.userId);
    await until(clock, () => personOf(bob, alice.userId).machine !== undefined, 20_000);

    // Nobody connected: said so (this PC can tell), rather than nothing.
    await until(clock, () => alice.appInfo().machine?.remote !== undefined, 30_000);
    expect(alice.appInfo().machine!.remote).toEqual({ inUse: false, sessions: [] });
    await until(clock, () => personOf(bob, alice.userId).machine?.remote?.inUse === false, 30_000);

    // Somebody connects with Remote Desktop Connection from another computer.
    sessions = [{ state: 'active', client: 'LAPTOP-9', address: '10.0.0.7' }];
    await until(clock, () => personOf(bob, alice.userId).machine?.remote?.inUse === true, 60_000);
    expect(personOf(bob, alice.userId).machine!.remote!.sessions).toEqual([
      { state: 'active', client: 'LAPTOP-9', address: '10.0.0.7' },
    ]);
    expect(alice.appInfo().machine!.remote!.inUse).toBe(true);

    // They disconnect but leave the session open: nobody is looking, and that is said too.
    sessions = [{ state: 'disconnected', client: 'LAPTOP-9' }];
    await until(clock, () => personOf(bob, alice.userId).machine?.remote?.inUse === false, 60_000);
    expect(personOf(bob, alice.userId).machine!.remote!.sessions[0]!.state).toBe('disconnected');

    // And they are gone.
    sessions = [];
    await until(
      clock,
      () => personOf(bob, alice.userId).machine?.remote?.sessions.length === 0,
      60_000,
    );
    // The PC without the means to look says nothing at all.
    expect(bob.appInfo().machine?.remote).toBeUndefined();
  });
});
describe('M6.20 the database from before: duplicate reaction entries are tidied once', () => {
  it('keeps the newest entry for each person and message, with its emojis, and drops the rest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'intercom-activity-'));
    const file = join(dir, 'x.db');
    try {
      const before = Store.open(
        file,
        MIGRATIONS.filter((m) => m.version <= 14),
      );
      const addReaction = (target: number, user: string, emoji: string, present: number) =>
        before.db
          .prepare(
            `INSERT INTO reactions (conv_id, target_author, target_seq, user_id, emoji, present, hlc_t, hlc_c)
             VALUES ('c', 'me', ?, ?, ?, ?, ?, 0)`,
          )
          .run(target, user, emoji, present, 100 + target);
      const addEntry = (
        kind: string,
        user: string,
        target: number,
        source: number,
        emoji: string,
        at: number,
      ) =>
        before.db
          .prepare(
            `INSERT INTO activity (kind, conv_id, author, target_author, target_seq, source_seq, emoji, at, read)
             VALUES (?, 'c', ?, 'me', ?, ?, ?, ?, 0)`,
          )
          .run(kind, user, target, source, emoji, at);
      // Dana reacted to message 1 ten times with different emoji, and has two on it now.
      for (let i = 0; i < 10; i++)
        addEntry('reaction', 'dana', 1, 10 + i, ['😡', '😮', '😛', '❤', '👍'][i % 5]!, 1000 + i);
      addReaction(1, 'dana', '❤', 1);
      addReaction(1, 'dana', '👍', 1);
      addReaction(1, 'dana', '😡', 0);
      // Lee reacted to message 2 and took it off again: nothing to show.
      addEntry('reaction', 'lee', 2, 30, '❤', 2000);
      addReaction(2, 'lee', '❤', 0);
      // Lee has a reaction on message 3: one entry stays.
      addEntry('reaction', 'lee', 3, 31, '👍', 2001);
      addReaction(3, 'lee', '👍', 1);
      // A mention is not touched.
      addEntry('mention', 'lee', 4, 40, '', 3000);
      before.db.close();

      const after = Store.open(file);
      const rows = after.db
        .prepare(
          'SELECT kind, author, target_seq AS target, emoji FROM activity ORDER BY kind, author, target',
        )
        .all() as Array<{ kind: string; author: string; target: number; emoji: string }>;
      expect(rows.map((r) => `${r.kind}:${r.author}:${r.target}`)).toEqual([
        'mention:lee:4',
        'reaction:dana:1',
        'reaction:lee:3',
      ]);
      expect(
        rows
          .find((r) => r.author === 'dana')!
          .emoji.split(' ')
          .sort(),
      ).toEqual(['❤', '👍'].sort());
      expect(after.schemaVersion).toBe(MIGRATIONS.at(-1)!.version);
      after.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
