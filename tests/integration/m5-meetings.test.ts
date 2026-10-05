import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Core, Toast } from '@officemesh/core';
import { FakeClock } from '@officemesh/core/testing';
import { startInProcessPeers, type InProcessSim } from '@officemesh/sim';
import type { IpcEventPayload } from '@officemesh/protocol/ipc';
import { allKnowEachOther, run, until } from './helpers.ts';

const sims: InProcessSim[] = [];
afterEach(async () => {
  for (const s of sims.splice(0)) await s.stop();
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

async function lan(count: number) {
  const clock = new FakeClock();
  const sim = await startInProcessPeers({ count, clock });
  sims.push(sim);
  const toasts = new Map<number, Toast[]>();
  const hook = (i: number) => {
    const list: Toast[] = [];
    toasts.set(i, list);
    (
      sim.peers[i]!.core as unknown as { options: { host: object; downloadsDir: string } }
    ).options.host = {
      fixFirewall: async () => {},
      openNetworkSettings: () => {},
      notify: (t: Toast) => list.push(t),
    };
  };
  for (let i = 0; i < count; i++) hook(i);
  const core = (i: number) => sim.peers[i]!.core;
  await until(clock, () => allKnowEachOther(sim.peers.filter(Boolean).map((p) => p.core)), 20_000);
  return { clock, sim, core, toasts, hook };
}

function events(core: Core) {
  const reactions: Array<IpcEventPayload<'call.reaction'>> = [];
  const controlled: Array<IpcEventPayload<'call.controlled'>> = [];
  core.onEvent((name, payload) => {
    if (name === 'call.reaction') reactions.push(payload as IpcEventPayload<'call.reaction'>);
    if (name === 'call.controlled') controlled.push(payload as IpcEventPayload<'call.controlled'>);
  });
  return { reactions, controlled };
}

const people = (c: Core) => (c.currentCall()?.participants.map((p) => p.userId) ?? []).sort();

describe('M5 scheduled meetings', () => {
  it('reaches every invitee, including one offline when it was scheduled', async () => {
    const { clock, sim, core } = await lan(3);
    const [alice, bob] = [core(0), core(1)];
    const carolId = core(2).userId;
    await sim.stopPeer(2);
    const start = clock.now() + 2 * DAY;
    const { convId, target } = alice.scheduleMeeting({
      title: 'Budget review',
      start,
      end: start + HOUR,
      recurrence: { freq: 'weekly' },
      notes: 'Bring the Q3 numbers',
      invitees: [bob.userId, carolId],
    });
    const range = [clock.now(), clock.now() + 22 * DAY] as const;
    await until(clock, () => bob.meetingOccurrences(...range).length === 3, 5_000);
    const first = bob.meetingOccurrences(...range)[0]!;
    expect(first).toMatchObject({
      title: 'Budget review',
      organizer: alice.userId,
      start,
      end: start + HOUR,
      convId,
    });
    expect(first.attendees.sort()).toEqual([alice.userId, bob.userId, carolId].sort());

    // Carol was off: she gets it when she comes back.
    const carol = (await sim.startPeer(2)).core;
    await until(clock, () => carol.meetingOccurrences(...range).length === 3, 30_000);

    // RSVPs, one cancelled occurrence, and an update by the organiser reach everyone.
    bob.rsvpMeeting(convId, target, 'accepted');
    carol.rsvpMeeting(convId, target, 'declined');
    alice.cancelMeeting(convId, target, start + 7 * DAY);
    alice.updateMeeting({
      convId,
      target,
      title: 'Budget review (new room)',
      start,
      end: start + 2 * HOUR,
      recurrence: { freq: 'weekly' },
    });
    await run(clock, 2_000);
    for (const c of [alice, bob, carol]) {
      const occ = c.meetingOccurrences(...range);
      expect(occ.map((o) => o.title)).toEqual(Array(3).fill('Budget review (new room)'));
      expect(occ.map((o) => o.cancelled)).toEqual([false, true, false]);
      expect(occ[0]!.end - occ[0]!.start).toBe(2 * HOUR);
      expect(occ[0]!.rsvps).toEqual(
        [
          { userId: bob.userId, response: 'accepted' },
          { userId: carol.userId, response: 'declined' },
        ].sort((a, b) => (a.userId < b.userId ? -1 : 1)),
      );
    }
    // Only the organiser may change or cancel it; a forged change is ignored everywhere.
    expect(() => bob.cancelMeeting(convId, target)).toThrow(/organiser/);
    bob.network!.sync.append(convId, 'meeting.cancel', { target });
    await run(clock, 1_000);
    expect(alice.meetingOccurrences(...range)[0]!.cancelled).toBe(false);

    // The views survive a rebuild unchanged.
    for (const c of [alice, bob, carol]) {
      const before = c.messages.dump();
      c.rebuild();
      expect(c.messages.dump()).toBe(before);
    }
  });

  it('reminds 15 minutes before, once, and exports an .ics file', async () => {
    const { clock, core, toasts } = await lan(2);
    const [alice, bob] = [core(0), core(1)];
    const start = clock.now() + 20 * 60_000;
    const { convId, target } = alice.scheduleMeeting({
      title: 'Stand-up',
      start,
      end: start + 15 * 60_000,
      recurrence: { freq: 'weekdays', until: start + 30 * DAY },
      invitees: [bob.userId],
    });
    await until(clock, () => bob.meetingOccurrences(start - 1, start + 1).length === 1, 5_000);
    bob.remindMeetings();
    expect(toasts.get(1)!.filter((t) => t.title.startsWith('Stand-up'))).toHaveLength(0);
    await run(clock, 6 * 60_000, 1_000);
    bob.remindMeetings();
    bob.remindMeetings();
    const reminders = toasts.get(1)!.filter((t) => t.title.startsWith('Stand-up'));
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.title).toMatch(/in (14|15) minutes/);

    const dir = mkdtempSync(join(tmpdir(), 'officemesh-ics-'));
    (bob as unknown as { options: { downloadsDir: string } }).options.downloadsDir = dir;
    const { path } = bob.exportMeetingIcs(convId, target);
    const ics = readFileSync(path, 'utf8');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('SUMMARY:Stand-up');
    expect(ics).toMatch(/RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;UNTIL=\d{8}T\d{6}Z/);
    expect(ics.split('\r\n').every((line) => Buffer.byteLength(line) <= 75)).toBe(true);
  });
});

describe('M5 meetings in progress', () => {
  it('Meet now posts a card others join from; the last to leave marks it over', async () => {
    const { clock, core } = await lan(3);
    const [alice, bob, carol] = [core(0), core(1), core(2)];
    const group = alice.createGroup([bob.userId, carol.userId], 'Design').convId;
    await until(
      clock,
      () => carol.conversationList().some((c) => c.convId === group && c.active),
      5_000,
    );
    const call = await alice.meetNow(group, 'video');
    expect(call).toMatchObject({ state: 'active', organizer: alice.userId });
    const card = () => bob.listMessages(group).find((m) => m.kindDetail === 'call');
    await until(clock, () => card() !== undefined, 5_000);
    expect(card()!.callCard).toMatchObject({ callId: call.callId, ended: false });

    // Bob joins from the card; Carol joins through Meet now (the meeting is already on).
    const joined = bob.joinCall(group, card()!);
    await run(clock, 500);
    expect((await joined).callId).toBe(call.callId);
    const carolJoin = carol.meetNow(group, 'video');
    await run(clock, 500);
    expect((await carolJoin).callId).toBe(call.callId);
    const all = [alice, bob, carol].map((c) => c.userId).sort();
    await until(
      clock,
      () => [alice, bob, carol].every((c) => people(c).join() === all.join()),
      5_000,
    );

    // A meeting stays open with one person left; when the last leaves, the card says so.
    bob.hangupCall(call.callId);
    carol.hangupCall(call.callId);
    await run(clock, 1_000);
    expect(people(alice)).toEqual([alice.userId]);
    alice.hangupCall(call.callId);
    await until(clock, () => card()!.callCard!.ended, 5_000);
    await expect(bob.joinCall(group, card()!)).rejects.toThrow(/ended/);
  });

  it('two people starting the same scheduled meeting at once end up in one call', async () => {
    const { clock, core } = await lan(2);
    const [alice, bob] = [core(0), core(1)];
    const start = clock.now() + HOUR;
    const { convId, target } = alice.scheduleMeeting({
      title: 'Sync',
      start,
      end: start + HOUR,
      recurrence: { freq: 'none' },
      invitees: [bob.userId],
    });
    await until(clock, () => bob.meetingOccurrences(start - 1, start + 1).length === 1, 5_000);
    const [a, b] = await Promise.all([
      alice.meetNow(convId, 'audio', target),
      bob.meetNow(convId, 'audio', target),
    ]);
    expect(a.callId).toBe(b.callId);
    const both = [alice.userId, bob.userId].sort();
    await until(
      clock,
      () => people(alice).join() === both.join() && people(bob).join() === both.join(),
      10_000,
    );
  });

  it('only the organiser can mute, remove and spotlight; reactions reach everyone', async () => {
    const { clock, core } = await lan(3);
    const [alice, bob, carol] = [core(0), core(1), core(2)];
    const seen = [alice, bob, carol].map(events);
    const group = alice.createGroup([bob.userId, carol.userId]).convId;
    await until(
      clock,
      () => carol.conversationList().some((c) => c.convId === group && c.active),
      5_000,
    );
    const call = await alice.meetNow(group, 'video');
    const card = () => bob.listMessages(group).find((m) => m.kindDetail === 'call');
    await until(
      clock,
      () => card() !== undefined && carol.listMessages(group).some((m) => m.kindDetail === 'call'),
      5_000,
    );
    const j1 = bob.joinCall(group, card()!);
    const j2 = carol.joinCall(group, card()!);
    await run(clock, 1_000);
    await Promise.all([j1, j2]);

    // A member cannot use organiser controls, even by sending the message directly.
    expect(() => bob.controlCall(call.callId, 'mute', null)).toThrow(/organiser/);
    bob.network!.links.send(carol.userId, 'call.control', {
      callId: call.callId,
      action: 'remove',
      target: carol.userId,
    });
    await run(clock, 500);
    expect(carol.currentCall()?.callId).toBe(call.callId);

    alice.controlCall(call.callId, 'mute', null);
    alice.controlCall(call.callId, 'spotlight', bob.userId);
    bob.updateCall(call.callId, { hand: true });
    bob.reactInCall(call.callId, '👏');
    await run(clock, 500);
    expect(seen[1]!.controlled).toEqual([{ callId: call.callId, action: 'mute' }]);
    expect(seen[2]!.controlled).toEqual([{ callId: call.callId, action: 'mute' }]);
    const entry = (c: Core, u: string) =>
      c.currentCall()!.participants.find((p) => p.userId === u)!;
    expect(entry(alice, bob.userId)).toMatchObject({ muted: true, hand: true });
    expect(entry(carol, alice.userId).spotlight).toBe(bob.userId);
    for (const s of seen)
      expect(s.reactions.map((r) => [r.from, r.emoji])).toEqual([[bob.userId, '👏']]);

    alice.controlCall(call.callId, 'remove', carol.userId);
    await until(clock, () => carol.currentCall() === null, 5_000);
    expect(seen[2]!.controlled.at(-1)?.action).toBe('remove');
    expect(people(alice)).toEqual([alice.userId, bob.userId].sort());
  });
});
