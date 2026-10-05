import { afterEach, describe, expect, it } from 'vitest';
import type { Core } from '@officemesh/core';
import { FakeClock } from '@officemesh/core/testing';
import { startInProcessPeers, type InProcessSim } from '@officemesh/sim';
import { allKnowEachOther, run, until } from './helpers.ts';

const sims: InProcessSim[] = [];
afterEach(async () => {
  for (const s of sims.splice(0)) await s.stop();
});

async function lan(count: number) {
  const clock = new FakeClock();
  const sim = await startInProcessPeers({ count, clock });
  sims.push(sim);
  const core = (i: number) => sim.peers[i]!.core;
  await until(clock, () => allKnowEachOther(sim.peers.filter(Boolean).map((p) => p.core)), 20_000);
  return { clock, sim, core };
}

const team = (c: Core, teamId: string) => c.teams().find((t) => t.teamId === teamId);
const channel = (c: Core, teamId: string, name: string) =>
  team(c, teamId)?.channels.find((ch) => ch.title === name);
const memberIds = (c: Core, convId: string) =>
  c
    .conversationMembers(convId)
    .map((m) => m.userId)
    .sort();

describe('M3 teams and channels', () => {
  it('creates a team with General, standard and private channels; only private members see private posts', async () => {
    const { clock, core } = await lan(3);
    const [owner, m1, m2] = [0, 1, 2].map(core) as [Core, Core, Core];
    const t = owner.createTeam({
      name: 'Finance',
      visibility: 'private',
      members: [m1.userId, m2.userId],
    });
    expect(t.role).toBe('owner');
    expect(t.channels.map((c) => c.title)).toEqual(['General']);
    await until(
      clock,
      () => [m1, m2].every((c) => team(c, t.teamId)?.channels.length === 1),
      5_000,
    );
    expect(team(m1, t.teamId)).toMatchObject({ name: 'Finance', role: 'member', memberCount: 3 });

    const budget = owner.createChannel({ teamId: t.teamId, name: 'Budget', private: false });
    const payroll = owner.createChannel({
      teamId: t.teamId,
      name: 'Payroll',
      private: true,
      members: [m1.userId],
    });
    await until(
      clock,
      () =>
        channel(m1, t.teamId, 'Payroll') !== undefined &&
        channel(m2, t.teamId, 'Budget') !== undefined,
      5_000,
    );
    expect(channel(m2, t.teamId, 'Payroll')).toBeUndefined();

    const general = t.channels[0]!.convId;
    const root = m1.sendMessage(general, 'Quarter close starts Monday', {
      announcement: { headline: 'Quarter close' },
    });
    owner.sendMessage(payroll.convId, 'Salaries are final');
    await run(clock, 1_000);
    m2.sendMessage(general, 'Noted', { thread: root });
    await run(clock, 500);
    owner.sendMessage(general, 'Thanks', { thread: root });
    await run(clock, 1_000);

    for (const c of [owner, m1, m2]) {
      const roots = c.listMessages(general, 50, undefined, true);
      expect(roots).toHaveLength(1);
      expect(roots[0]).toMatchObject({
        replyCount: 2,
        announcement: { headline: 'Quarter close' },
      });
      expect(c.threadMessages(general, root).map((m) => m.text)).toEqual([
        'Quarter close starts Monday',
        'Noted',
        'Thanks',
      ]);
    }
    expect(m1.listMessages(payroll.convId).map((m) => m.text)).toEqual(['Salaries are final']);
    expect(m2.conversationList().some((c) => c.convId === payroll.convId)).toBe(false);
    expect(budget.teamId).toBe(t.teamId);
    // Channels, threads and announcements rebuild to the same tables.
    for (const c of [owner, m1, m2]) {
      const before = c.messages.dump();
      c.rebuild();
      expect(c.messages.dump()).toBe(before);
    }
  });

  it("ignores a non-owner's member.remove on every peer", async () => {
    const { clock, core } = await lan(3);
    const [owner, m1, m2] = [0, 1, 2].map(core) as [Core, Core, Core];
    const t = owner.createTeam({
      name: 'Ops',
      visibility: 'private',
      members: [m1.userId, m2.userId],
    });
    await until(clock, () => [m1, m2].every((c) => team(c, t.teamId)), 5_000);
    m1.removeMember(t.teamId, m2.userId); // signed and sent, but not authorised
    m1.setTeamRole(t.teamId, m1.userId, 'owner'); // nor is promoting yourself
    await run(clock, 2_000);
    const everyone = [owner, m1, m2].map((c) => c.userId).sort();
    for (const c of [owner, m1, m2]) {
      expect(memberIds(c, t.teamId)).toEqual(everyone);
      expect(c.conversationMembers(t.teamId).find((m) => m.userId === m1.userId)?.role).toBe(
        'member',
      );
    }
    // An owner's removal does take effect, and the removed member sees nothing new.
    owner.removeMember(t.teamId, m2.userId);
    await run(clock, 1_000);
    const general = t.channels[0]!.convId;
    owner.sendMessage(general, 'after removal');
    await run(clock, 2_000);
    expect(m1.listMessages(general).map((m) => m.text)).toEqual(['after removal']);
    expect(m2.listMessages(general)).toHaveLength(0);
    expect(team(m2, t.teamId)?.role).toBeUndefined();
  });

  it('concurrent renames of a channel by two owners resolve to the same name everywhere', async () => {
    const { clock, sim, core } = await lan(3);
    const [o1, o2, m] = [0, 1, 2].map(core) as [Core, Core, Core];
    const t = o1.createTeam({
      name: 'Sales',
      visibility: 'private',
      members: [o2.userId, m.userId],
    });
    await until(clock, () => [o2, m].every((c) => team(c, t.teamId)), 5_000);
    o1.setTeamRole(t.teamId, o2.userId, 'owner');
    const ch = o1.createChannel({ teamId: t.teamId, name: 'Leads', private: false });
    await until(
      clock,
      () => team(o2, t.teamId)?.role === 'owner' && channel(m, t.teamId, 'Leads') !== undefined,
      5_000,
    );

    // Partition the two owners, rename on both sides, then heal.
    sim.unplug(1);
    o1.renameChannel(t.teamId, ch.convId, 'Leads EMEA');
    await run(clock, 300);
    o2.renameChannel(t.teamId, ch.convId, 'Leads APAC');
    await run(clock, 1_000);
    sim.replug(1);
    await until(
      clock,
      () =>
        new Set(
          [o1, o2, m].map((c) => c.conversationList().find((v) => v.convId === ch.convId)?.title),
        ).size === 1,
      60_000,
    );
    // The later rename (by HLC) wins.
    expect(o1.conversationList().find((v) => v.convId === ch.convId)?.title).toBe('Leads APAC');
  });

  it('a colleague discovers and joins a public team, then sees its standard channels', async () => {
    const { clock, core } = await lan(3);
    const [owner, member, newcomer] = [0, 1, 2].map(core) as [Core, Core, Core];
    const t = owner.createTeam({
      name: 'Book club',
      visibility: 'public',
      members: [member.userId],
    });
    owner.createTeam({ name: 'Secret', visibility: 'private', members: [member.userId] });
    const general = t.channels[0]!.convId;
    owner.sendMessage(general, 'Welcome, readers');
    await until(clock, () => team(member, t.teamId) !== undefined, 5_000);

    await run(clock, 1_000);
    const found = await newcomer.discoverTeams();
    expect(found.map((f) => f.name)).toEqual(['Book club']);
    const joined = await newcomer.joinTeam(t.teamId);
    expect(joined).toMatchObject({ name: 'Book club', role: 'member' });
    await until(
      clock,
      () => newcomer.listMessages(general).length === 1 && team(owner, t.teamId)?.memberCount === 3,
      10_000,
    );
    expect(newcomer.listMessages(general)[0]!.text).toBe('Welcome, readers');
  });
});
