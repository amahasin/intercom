import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KEY_FILE_NAME, type Core } from '@officemesh/core';
import { FakeClock } from '@officemesh/core/testing';
import { simProfile, startInProcessPeers } from '@officemesh/sim';
import type { MsgRef } from '@officemesh/protocol';
import { allKnowEachOther, settle, until } from './helpers.ts';

/** mulberry32: a small, fast, seedable PRNG, so a failing seed replays exactly. */
function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: readonly T[]): T | undefined =>
      xs.length ? xs[Math.floor(next() * xs.length)] : undefined,
    chance: (p: number) => next() < p,
  };
}

/**
 * The same identity keys for every run (generated once into the temp folder), so user ids,
 * and with them every tie-break, are the same on each replay of a seed.
 */
async function freshDataRoot(peers: number): Promise<string> {
  const keyTemplate = join(tmpdir(), `officemesh-fuzzkeys-${peers}`);
  if (!existsSync(join(keyTemplate, simProfile(peers - 1), KEY_FILE_NAME))) {
    rmSync(keyTemplate, { recursive: true, force: true });
    const sim = await startInProcessPeers({
      count: peers,
      dataRoot: keyTemplate,
      keepData: true,
      network: false,
    });
    await sim.stop();
  }
  const root = mkdtempSync(join(tmpdir(), 'officemesh-fuzz-'));
  for (let i = 0; i < peers; i++) {
    mkdirSync(join(root, simProfile(i)));
    copyFileSync(
      join(keyTemplate, simProfile(i), KEY_FILE_NAME),
      join(root, simProfile(i), KEY_FILE_NAME),
    );
  }
  return root;
}

export interface FuzzOptions {
  peers: number;
  ops: number;
  progress?: (message: string) => void;
  /** Called with every core when a run did not converge, before they are stopped. */
  inspect?: (cores: Core[]) => void;
}

export interface FuzzResult {
  seed: number;
  converged: boolean;
  /** Conversations whose current members disagree, with a short reason. */
  problems: string[];
  applied: number;
  simulatedMs: number;
}

/** Everything about a conversation that every current member must agree on. */
function fingerprint(core: Core, convId: string): string {
  const db = core.store.db;
  const q = (sql: string) => JSON.stringify(db.prepare(sql).all(convId));
  const view = core.conversationList().find((c) => c.convId === convId);
  return [
    view?.title,
    JSON.stringify(core.conversationMembers(convId).map((m) => [m.userId, m.role])),
    q(`SELECT author, seq, hlc_t, hlc_c, kind, text, deleted, edited_t, edited_c, thread_author, thread_seq
         FROM messages WHERE conv_id = ? ORDER BY hlc_t, hlc_c, author, seq`),
    q(
      'SELECT * FROM reactions WHERE conv_id = ? ORDER BY target_author, target_seq, user_id, emoji',
    ),
    q('SELECT * FROM pins WHERE conv_id = ? ORDER BY target_author, target_seq'),
    q('SELECT * FROM poll_votes WHERE conv_id = ? ORDER BY target_author, target_seq, voter'),
    q('SELECT * FROM poll_close WHERE conv_id = ? ORDER BY target_author, target_seq'),
  ].join('\n');
}

function disagreements(cores: Core[], verbose = false): string[] {
  const convIds = new Set(
    cores.flatMap((c) =>
      c
        .conversationList()
        .filter((v) => v.kind !== 'direct')
        .map((v) => v.convId),
    ),
  );
  const problems: string[] = [];
  for (const convId of convIds) {
    const holders = cores.filter(
      (c) => c.conversationList().find((v) => v.convId === convId)?.active,
    );
    const prints = new Set(holders.map((c) => fingerprint(c, convId)));
    if (prints.size > 1) {
      const [x, y] = [...prints].map((p) => p.split(String.fromCharCode(10)));
      const part = x!.findIndex((line, i) => line !== y![i]);
      const names = ['title', 'members', 'messages', 'reactions', 'pins', 'votes', 'close'];
      problems.push(
        `${convId}: ${prints.size} different views among ${holders.length} members (${names[part]})`,
      );
      if (verbose) {
        const diff = (a: string, b: string) => {
          const ra = JSON.parse(a) as unknown[];
          const rb = JSON.parse(b) as unknown[];
          const sa = new Set(ra.map((r) => JSON.stringify(r)));
          const sb = new Set(rb.map((r) => JSON.stringify(r)));
          return {
            onlyA: [...sa].filter((r) => !sb.has(r)).slice(0, 5),
            onlyB: [...sb].filter((r) => !sa.has(r)).slice(0, 5),
          };
        };
        const kind = (
          cores.find((c) => c.conversationList().some((v) => v.convId === convId)) ?? cores[0]!
        )
          .conversationList()
          .find((v) => v.convId === convId)?.kind;
        console.log(kind, part, part >= 2 ? diff(x![part]!, y![part]!) : [x![part], y![part]]);
        for (const c of holders) console.log(c.userId, fingerprint(c, convId) === [...prints][0]);
      }
    }
  }
  // Every current member must hold the conversation.
  for (const c of cores) {
    for (const t of c.teams().filter((x) => x.role)) {
      const memberIds = c.conversationMembers(t.teamId).map((m) => m.userId);
      for (const other of cores) {
        if (
          memberIds.includes(other.userId) &&
          !other.teams().some((x) => x.teamId === t.teamId && x.role)
        ) {
          problems.push(`${other.userId} is a member of ${t.teamId} but does not know it`);
        }
      }
    }
  }
  return problems;
}

/**
 * One randomised run: `peers` cores on a simulated LAN share a group and a team with
 * channels, then perform `ops` random actions (posts, threads, edits, deletes, reactions,
 * pins, polls, membership and channel changes) while peers are cut off and reconnected
 * at random and every link delays frames randomly (so frames on different links overtake
 * each other). Afterwards the LAN heals and every conversation must converge.
 */
export async function fuzzRun(seed: number, options: FuzzOptions): Promise<FuzzResult> {
  const rnd = prng(seed);
  const clock = new FakeClock();
  const dataRoot = await freshDataRoot(options.peers);
  const sim = await startInProcessPeers({ count: options.peers, clock, dataRoot });
  try {
    sim.net.jitter = () => rnd.int(4);
    const cores = sim.peers.map((p) => p.core);
    await until(clock, () => allKnowEachOther(cores), 30_000);
    const [founder] = cores as [Core];
    const others = cores.slice(1).map((c) => c.userId);
    const group = founder.createGroup(
      others.slice(0, Math.max(2, others.length - 2)),
      'Fuzz group',
    ).convId;
    const team = founder.createTeam({ name: 'Fuzz team', visibility: 'public', members: others });
    founder.setTeamRole(team.teamId, others[0]!, 'owner');
    const side = founder.createChannel({ teamId: team.teamId, name: 'side', private: false });
    founder.createChannel({
      teamId: team.teamId,
      name: 'secret',
      private: true,
      members: others.slice(0, 3),
    });
    await until(
      clock,
      () => cores.every((c) => c.teams().some((t) => t.channels.length >= 2)),
      30_000,
    );
    void side;

    const unplugged = new Set<number>();
    const own = new Map<Core, Array<{ convId: string; ref: MsgRef }>>();
    const posts: Array<{ convId: string; ref: MsgRef; poll: boolean; root: boolean }> = [];
    let applied = 0;

    const convsOf = (c: Core) =>
      c
        .conversationList()
        .filter((v) => v.active && !v.archived && v.kind !== 'direct' && v.kind !== 'team');
    const people = (c: Core) => cores.filter((x) => x !== c).map((x) => x.userId);

    for (let step = 0; step < options.ops; step++) {
      const i = rnd.int(cores.length);
      const c = cores[i]!;
      const r = rnd.next();
      try {
        if (r < 0.03) {
          // Partition: cut a peer off or bring one back.
          if (unplugged.size > 0 && rnd.chance(0.5)) {
            const back = rnd.pick([...unplugged])!;
            unplugged.delete(back);
            sim.replug(back);
          } else if (unplugged.size < Math.floor(cores.length / 3)) {
            unplugged.add(i);
            sim.unplug(i);
          }
          continue;
        }
        const conv = rnd.pick(convsOf(c));
        if (!conv) continue;
        const mine = (own.get(c) ?? []).filter((m) => m.convId === conv.convId);
        const target = rnd.pick(posts.filter((p) => p.convId === conv.convId));
        if (r < 0.5) {
          const roots = posts.filter((p) => p.convId === conv.convId && p.root && !p.poll);
          const thread =
            conv.kind === 'channel' && rnd.chance(0.3) ? rnd.pick(roots)?.ref : undefined;
          const m = c.sendMessage(conv.convId, `m${step} from ${i}`, { ...(thread && { thread }) });
          const ref = { author: m.author, seq: m.seq };
          posts.push({ convId: conv.convId, ref, poll: false, root: !thread });
          own.set(c, [...(own.get(c) ?? []), { convId: conv.convId, ref }]);
        } else if (r < 0.62 && target) {
          c.react(conv.convId, target.ref, rnd.pick(['👍', '❤️', '😆'])!, rnd.chance(0.7));
        } else if (r < 0.7 && mine.length) {
          c.editMessage(conv.convId, rnd.pick(mine)!.ref, `edited at ${step}`);
        } else if (r < 0.73 && mine.length) {
          c.deleteMessage(conv.convId, rnd.pick(mine)!.ref);
        } else if (r < 0.76 && target) {
          c.pin(conv.convId, target.ref, rnd.chance(0.6));
        } else if (r < 0.79) {
          const poll = c.createPoll(conv.convId, {
            question: `q${step}`,
            options: ['a', 'b', 'c'],
            multi: rnd.chance(0.3),
          });
          posts.push({
            convId: conv.convId,
            ref: { author: poll.author, seq: poll.seq },
            poll: true,
            root: true,
          });
        } else if (r < 0.86) {
          const poll = rnd.pick(posts.filter((p) => p.convId === conv.convId && p.poll));
          if (poll) {
            if (poll.ref.author === c.userId && rnd.chance(0.2)) c.closePoll(conv.convId, poll.ref);
            else c.vote(conv.convId, poll.ref, [rnd.int(3)]);
          }
        } else if (r < 0.9) {
          // Membership in the group: any member adds or removes anyone.
          if (conv.convId === group) {
            const who = rnd.pick(people(c))!;
            if (rnd.chance(0.5)) c.addMembers(group, [who]);
            else c.removeMember(group, who);
          }
        } else if (r < 0.95) {
          // Team control: owners succeed, members' attempts must be ignored everywhere.
          const roll = rnd.int(5);
          const who = rnd.pick(people(c))!;
          if (roll === 0)
            c.renameChannel(team.teamId, rnd.pick(team.channels.concat(side))!.convId, `ch${step}`);
          else if (roll === 1) c.addMembers(team.teamId, [who]);
          else if (roll === 2) c.removeMember(team.teamId, who);
          else if (roll === 3)
            c.setTeamRole(team.teamId, who, rnd.chance(0.3) ? 'owner' : 'member');
          else c.renameChannel(team.teamId, side.convId, `side ${step}`);
        } else if (r < 0.96 && conv.convId === group && c !== founder) {
          c.leave(group);
        }
        applied++;
      } catch {
        // Not allowed from this peer's point of view right now (not a member, closed poll…).
      }
      clock.advance(rnd.int(150));
      await settle(rnd.int(4) + 1);
      if (step % 200 === 0) options.progress?.(`step ${step}, applied ${applied}`);
    }
    options.progress?.(`ops done, healing`);

    // Heal the LAN and let anti-entropy finish.
    for (const i of unplugged) sim.replug(i);
    const start = clock.now();
    let problems: string[] = [];
    try {
      await until(
        clock,
        () => {
          problems = disagreements(cores);
          return problems.length === 0;
        },
        180_000,
        1_000,
      );
    } catch {
      // Reported through `problems`.
      if (process.env['FUZZ_VERBOSE']) disagreements(cores, true);
      options.inspect?.(cores);
    }
    return {
      seed,
      converged: problems.length === 0,
      problems,
      applied,
      simulatedMs: clock.now() - start,
    };
  } finally {
    await sim.stop();
    rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5 });
  }
}
