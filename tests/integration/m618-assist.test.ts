import { afterEach, describe, expect, it } from 'vitest';
import type { AssistExit, Core, RemoteAssistHost } from '@officemesh/core';
import { FakeClock } from '@officemesh/core/testing';
import { startInProcessPeers, type InProcessSim } from '@officemesh/sim';
import { allKnowEachOther, run, until } from './helpers.ts';

const CONNECTION = '<E><A KH="x"/></E>';
const SCREENS = [
  { w: 1920, h: 1080, primary: true },
  { w: 1280, h: 720, primary: false },
];

/** Stands in for the sharing helper: records what it was asked, and can end a session "by hand". */
class FakeAssistHost implements RemoteAssistHost {
  available = true;
  shared: Array<{ sessionId: string; peerName: string }> = [];
  viewed: Array<{
    sessionId: string;
    ticket: string;
    password: string;
    peerName: string;
    selfName: string;
    screens: number;
  }> = [];
  picked: Array<{ sessionId: string; index: number }> = [];
  controls: Array<{ sessionId: string; on: boolean }> = [];
  stopped: string[] = [];
  settingsOpened = 0;
  private exit: ((sessionId: string, reason: AssistExit) => void) | undefined;
  private screen: ((sessionId: string, index: number) => void) | undefined;
  private chat: ((sessionId: string) => void) | undefined;
  private control: ((sessionId: string, on: boolean) => void) | undefined;
  status = async () => ({ available: this.available, allowed: true });
  share = async (sessionId: string, peerName: string) => {
    this.shared.push({ sessionId, peerName });
    return { ticket: CONNECTION, password: 'sessionpassword1234', screens: SCREENS };
  };
  view = async (
    sessionId: string,
    c: {
      ticket: string;
      password: string;
      screens: unknown[];
      peerName: string;
      selfName: string;
    },
  ) => {
    this.viewed.push({
      sessionId,
      ticket: c.ticket,
      password: c.password,
      peerName: c.peerName,
      selfName: c.selfName,
      screens: c.screens.length,
    });
  };
  selectScreen = (sessionId: string, index: number) => void this.picked.push({ sessionId, index });
  setControl = (sessionId: string, on: boolean) => {
    this.controls.push({ sessionId, on });
    this.control?.(sessionId, on);
  };
  onControl = (listener: (sessionId: string, on: boolean) => void) =>
    void (this.control = listener);
  stop = (sessionId: string) => void this.stopped.push(sessionId);
  onExit = (listener: (sessionId: string, reason: AssistExit) => void) =>
    void (this.exit = listener);
  onScreen = (listener: (sessionId: string, index: number) => void) =>
    void (this.screen = listener);
  onChat = (listener: (sessionId: string) => void) => void (this.chat = listener);
  openSettings = () => void this.settingsOpened++;
  /** The helper ended by itself. */
  ends(sessionId: string, reason: AssistExit): void {
    this.exit?.(sessionId, reason);
  }
  /** The helper says control is on or off (a colleague connected, or the tray menu was used). */
  controlIs(sessionId: string, on: boolean): void {
    this.control?.(sessionId, on);
  }
  /** The viewer picked a screen in its window. */
  pick(sessionId: string, index: number): void {
    this.screen?.(sessionId, index);
  }
  /** The viewer pressed Conversation. */
  openChat(sessionId: string): void {
    this.chat?.(sessionId);
  }
}

const sims: InProcessSim[] = [];
afterEach(async () => {
  for (const s of sims.splice(0)) await s.stop();
});

async function pair() {
  const clock = new FakeClock();
  const hosts = [new FakeAssistHost(), new FakeAssistHost()];
  const sim = await startInProcessPeers({
    count: 2,
    clock,
    coreOptions: (i) => ({
      host: { fixFirewall: async () => {}, openNetworkSettings: () => {}, remoteAssist: hosts[i]! },
    }),
  });
  sims.push(sim);
  const [a, b] = [0, 1].map((i) => sim.peers[i]!.core) as [Core, Core];
  await until(clock, () => allKnowEachOther([a, b]), 20_000);
  return { clock, a, b, ha: hosts[0]!, hb: hosts[1]!, sim };
}

const only = (c: Core) => {
  const list = c.assistList();
  expect(list).toHaveLength(1);
  return list[0]!;
};

/** A session that is open: A asked for help, B accepted. */
async function openHelpMe() {
  const t = await pair();
  const asked = await t.a.assistRequest(t.b.userId, 'help-me');
  await run(t.clock, 500);
  await t.b.assistAccept(asked.sessionId);
  await run(t.clock, 1_000);
  return { ...t, id: asked.sessionId };
}

describe('M6.18 remote help', () => {
  it('"help me": the asker shares, the helper gets the connection details and connects', async () => {
    const { clock, a, b, ha, hb } = await pair();
    const asked = await a.assistRequest(b.userId, 'help-me');
    expect(asked).toMatchObject({ state: 'asking', role: 'sharer', mine: true });
    await run(clock, 500);
    expect(only(b)).toMatchObject({ state: 'asked', role: 'viewer', mine: false, peer: a.userId });
    // Nothing is started on either PC before the answer: the answer is the permission.
    expect(ha.shared).toHaveLength(0);
    expect(hb.viewed).toHaveLength(0);

    await b.assistAccept(asked.sessionId);
    await run(clock, 1_000);
    expect(ha.shared).toHaveLength(1);
    expect(ha.shared[0]!.sessionId).toBe(asked.sessionId);
    // The viewer is handed the details made on the sharing PC, with both people's names: no
    // password is asked of anyone.
    expect(hb.viewed).toHaveLength(1);
    expect(hb.viewed[0]).toMatchObject({
      sessionId: asked.sessionId,
      ticket: CONNECTION,
      password: 'sessionpassword1234',
      screens: 2,
    });
    expect(hb.viewed[0]!.peerName.length).toBeGreaterThan(0);
    expect(only(a).state).toBe('open');
    expect(only(b).state).toBe('open');

    // The helper ends it in InterCom: both sides stop their helper.
    await b.assistEnd(asked.sessionId);
    await run(clock, 500);
    expect(only(a)).toMatchObject({ state: 'ended', endReason: 'cancelled', endedBy: 'peer' });
    expect(only(b)).toMatchObject({ state: 'ended', endReason: 'cancelled', endedBy: 'me' });
    expect(ha.stopped).toEqual([asked.sessionId]);
    expect(hb.stopped).toEqual([asked.sessionId]);
  });

  it('"let me in": the asked person shares once they allow it', async () => {
    const { clock, a, b, ha, hb } = await pair();
    const asked = await a.assistRequest(b.userId, 'let-me-in');
    expect(asked.role).toBe('viewer');
    await run(clock, 500);
    expect(only(b)).toMatchObject({ state: 'asked', role: 'sharer', kind: 'let-me-in' });
    await b.assistAccept(asked.sessionId);
    await run(clock, 1_000);
    expect(hb.shared.map((s) => s.sessionId)).toEqual([asked.sessionId]);
    expect(ha.viewed.map((v) => v.sessionId)).toEqual([asked.sessionId]);
    expect(ha.viewed[0]!.ticket).toBe(CONNECTION);
  });

  it('the sharing PC can stop control and give it back, and sees it when the helper changes it', async () => {
    const { clock, a, b, ha, hb, id } = await openHelpMe();
    // Nothing is said about control until the colleague has connected.
    expect(only(a).control).toBeUndefined();
    ha.controlIs(id, true);
    await run(clock, 200);
    expect(only(a).control).toBe(true);
    // The person sharing stops control in InterCom: the helper is told, the view says so.
    const stopped = await a.assistControl(id, false);
    expect(stopped.control).toBe(false);
    expect(ha.controls).toEqual([{ sessionId: id, on: false }]);
    expect(only(a).control).toBe(false);
    // And gives it back.
    expect((await a.assistControl(id, true)).control).toBe(true);
    // The helper's own menu changes it: InterCom follows.
    ha.controlIs(id, false);
    await run(clock, 200);
    expect(only(a).control).toBe(false);
    // Only the sharing PC has the switch.
    await expect(b.assistControl(id, false)).rejects.toThrow(/shared PC/);
    expect(only(b).control).toBeUndefined();
    expect(hb.controls).toHaveLength(0);
    // After the session ends there is nothing to switch.
    await a.assistEnd(id);
    await expect(a.assistControl(id, true)).rejects.toThrow(/shared PC/);
  });

  it('the viewer picks a screen and the sharing PC shows it; wrong choices are ignored', async () => {
    const { clock, a, b, ha, hb, id } = await openHelpMe();
    // B views A's desktop. B picks screen 2 in its window: A's helper is told.
    hb.pick(id, 1);
    await run(clock, 500);
    expect(ha.picked).toEqual([{ sessionId: id, index: 1 }]);
    hb.pick(id, -1);
    await run(clock, 500);
    expect(ha.picked.at(-1)).toEqual({ sessionId: id, index: -1 });
    // A screen A does not have (there are two) is not passed on.
    hb.pick(id, 5);
    await run(clock, 500);
    expect(ha.picked).toHaveLength(2);
    // The sharing side never switches the viewing side's screens.
    ha.pick(id, 0);
    await run(clock, 500);
    expect(hb.picked).toHaveLength(0);
    expect(only(a).state).toBe('open');
    expect(only(b).state).toBe('open');
  });

  it('the viewer\'s "Conversation" button opens the chat with the colleague', async () => {
    const { clock, b, hb, id, a } = await openHelpMe();
    const opened: Array<{ convId: string }> = [];
    b.onEvent((name, payload) => name === 'ui.open' && opened.push(payload as { convId: string }));
    hb.openChat(id);
    await run(clock, 200);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.convId).toBe(b.openDirect(a.userId).convId);
  });

  it('a helper that ends by itself ends the session on both PCs, with the right reason', async () => {
    // The person on A closed the sharing window ("End session"): the session is over for both.
    {
      const { clock, a, b, ha, id } = await openHelpMe();
      ha.ends(id, 'closed');
      await run(clock, 500);
      expect(only(a)).toMatchObject({ state: 'ended', endReason: 'closed', endedBy: 'me' });
      expect(only(b)).toMatchObject({ state: 'ended', endReason: 'closed', endedBy: 'peer' });
    }
    // The viewer could not reach the sharing PC (a firewall, usually): both are told so.
    {
      const { clock, a, b, hb, id } = await openHelpMe();
      hb.ends(id, 'no-connection');
      await run(clock, 500);
      expect(only(b)).toMatchObject({ state: 'ended', endReason: 'no-connection', endedBy: 'me' });
      expect(only(a)).toMatchObject({
        state: 'ended',
        endReason: 'no-connection',
        endedBy: 'peer',
      });
    }
    // The sharing helper broke.
    {
      const { clock, a, b, ha, id } = await openHelpMe();
      ha.ends(id, 'failed');
      await run(clock, 500);
      expect(only(a)).toMatchObject({ state: 'ended', endReason: 'failed', endedBy: 'me' });
      expect(only(b)).toMatchObject({ state: 'ended', endReason: 'failed', endedBy: 'peer' });
    }
  });

  it('declined, unanswered, or asked while busy: nothing is started', async () => {
    const { clock, a, b, ha, hb } = await pair();
    const first = await a.assistRequest(b.userId, 'help-me');
    await run(clock, 500);
    await b.assistDecline(first.sessionId);
    await run(clock, 500);
    expect(a.assistList().find((s) => s.sessionId === first.sessionId)).toMatchObject({
      state: 'ended',
      endReason: 'declined',
      endedBy: 'peer',
    });

    const second = await a.assistRequest(b.userId, 'let-me-in');
    await run(clock, 500);
    // While A waits for B's answer, B cannot start another session.
    await expect(b.assistRequest(a.userId, 'help-me')).rejects.toThrow(/already/);
    await run(clock, 61_000);
    expect(a.assistList().find((s) => s.sessionId === second.sessionId)).toMatchObject({
      state: 'ended',
      endReason: 'no-answer',
    });
    expect(b.assistList().find((s) => s.sessionId === second.sessionId)?.state).toBe('ended');
    expect(ha.shared.length + hb.shared.length + ha.viewed.length + hb.viewed.length).toBe(0);
  });

  it('a PC that cannot do remote help says so, before anyone is asked', async () => {
    const { clock, a, b, ha, hb } = await pair();
    ha.available = false;
    await expect(a.assistRequest(b.userId, 'help-me')).rejects.toThrow(/not available/);
    expect(a.assistList()).toHaveLength(0);
    // The colleague's PC cannot either: accepting says so and starts nothing.
    ha.available = true;
    hb.available = false;
    const asked = await a.assistRequest(b.userId, 'let-me-in');
    await run(clock, 500);
    await expect(b.assistAccept(asked.sessionId)).rejects.toThrow(/not available/);
    expect(only(b).state).toBe('asked');
    expect(hb.shared).toHaveLength(0);
    b.assistOpenSettings();
    expect(hb.settingsOpened).toBe(1);
  });

  it('a colleague cannot push connection details nobody asked for, nor switch a screen', async () => {
    const { clock, a, b, ha, sim } = await pair();
    const asked = await a.assistRequest(b.userId, 'let-me-in');
    await run(clock, 500);
    // B never accepted: details sent by B for this session must not be used on A.
    const links = sim.peers[1]!.core.network!.links;
    links.send(a.userId, 'assist.ticket', {
      sessionId: asked.sessionId,
      ticket: CONNECTION,
      password: 'abcdefgh12345678',
    });
    links.send(a.userId, 'assist.screen', { sessionId: asked.sessionId, index: 0 });
    await run(clock, 500);
    expect(only(a).state).toBe('asking');
    // A is the viewer: it must not have connected to something it did not agree to.
    expect(ha.viewed).toHaveLength(0);
    expect(ha.picked).toHaveLength(0);
    // Once B does accept, A connects as normal.
    await b.assistAccept(asked.sessionId);
    await run(clock, 1_000);
    expect(ha.viewed).toHaveLength(1);
  });

  it('details that are not a connection string are refused', async () => {
    const { clock, a, b, ha, sim } = await pair();
    const asked = await a.assistRequest(b.userId, 'let-me-in');
    await run(clock, 500);
    const links = sim.peers[1]!.core.network!.links;
    // B answers yes (so A is waiting for details), then sends something that is no connection string.
    links.send(a.userId, 'assist.accept', { sessionId: asked.sessionId });
    await run(clock, 500);
    expect(only(a).state).toBe('starting');
    links.send(a.userId, 'assist.ticket', {
      sessionId: asked.sessionId,
      ticket: 'run calc.exe',
      password: 'abcdefgh12345678',
    });
    await run(clock, 500);
    expect(only(a)).toMatchObject({ state: 'ended', endReason: 'failed' });
    expect(ha.viewed).toHaveLength(0);
  });
});
