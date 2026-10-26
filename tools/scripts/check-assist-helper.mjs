// Checks the remote help helper (intercom-assist.exe) on this PC: a sharing helper and a viewing
// helper are started and connected to each other, the way InterCom's main process does it.
//
//   node tools/scripts/check-assist-helper.mjs [path\to\intercom-assist.exe]
//
// It needs a Windows desktop (the helper opens windows, for a few seconds each) and cannot run in
// a build agent without one. The default path is the helper that `pnpm build` makes; for an
// installed or unpacked build, pass resources\intercom-assist.exe from it. The sharing side runs
// view-only, so nothing here can control the PC it runs on. Exit code 0: every check passed.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const exe = resolve(
  process.argv[2] ?? resolve(root, 'apps', 'desktop', 'dist', 'main', 'intercom-assist.exe'),
);
if (!existsSync(exe)) {
  console.error(`check-assist-helper: ${exe} not found; run pnpm build first`);
  process.exit(2);
}

const t0 = Date.now();
const log = (who, msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${who}: ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  log('check', `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
};

function launch(who, args) {
  const child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'ignore'] });
  const events = [];
  const waiters = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    events.push(ev);
    for (const w of [...waiters])
      if (w.match(ev)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(ev);
      }
  });
  const exited = new Promise((r) => child.on('exit', r));
  const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
  const wait = (match, ms = 20_000) =>
    new Promise((resolve, reject) => {
      const hit = events.find(match);
      if (hit) return resolve(hit);
      const w = { match, resolve };
      waiters.push(w);
      setTimeout(() => {
        if (!waiters.includes(w)) return;
        waiters.splice(waiters.indexOf(w), 1);
        reject(new Error(`${who}: timed out`));
      }, ms);
    });
  return { child, send, wait, events, exited };
}

const stopAll = (...helpers) => {
  for (const h of helpers)
    try {
      if (h && h.child.exitCode === null) h.child.kill();
    } catch {
      // Already gone.
    }
};

/** A sharer and a viewer, connected. */
async function pair(sharerArgs = []) {
  const sharer = launch('sharer', [
    'share',
    '--peer',
    'Check Colleague',
    '--control',
    'view',
    ...sharerArgs,
  ]);
  const ready = await sharer.wait((e) => e.event === 'ready' || e.event === 'error');
  if (ready.event !== 'ready') throw new Error(`the sharer did not start: ${ready.message}`);
  const viewer = launch('viewer', ['view']);
  viewer.send({
    cmd: 'connect',
    ticket: ready.ticket,
    password: ready.password,
    peer: 'Check Sharer',
    self: 'Check Viewer',
    screens: ready.screens,
  });
  await viewer.wait((e) => e.event === 'connected');
  await sharer.wait((e) => e.event === 'attendee');
  return { sharer, viewer, ready };
}

try {
  log('check', 'A: a sharing helper makes an invitation, a viewer connects with no prompt');
  {
    const { sharer, viewer, ready } = await pair();
    check(
      'the invitation holds a connection string, a password and the screens',
      ready.ticket.startsWith('<E>') &&
        ready.password.length >= 16 &&
        Array.isArray(ready.screens) &&
        ready.screens.length >= 1,
      `${ready.screens.length} screen(s)`,
    );
    check(
      'the viewer is told control is off (the sharer is view-only)',
      (await viewer.wait((e) => e.event === 'control', 10_000).catch(() => ({}))).on === false,
    );
    sharer.send({ cmd: 'screen', index: ready.screens.length > 1 ? 1 : 0 });
    sharer.send({ cmd: 'screen', index: -1 });
    await sleep(500);
    check(
      'choosing a screen, and all of them, does not upset the sharer',
      sharer.child.exitCode === null,
    );
    viewer.send({ cmd: 'control', on: true });
    await sleep(1500);
    sharer.send({ cmd: 'end' });
    const closed = await viewer.wait((e) => e.event === 'closed', 15_000).catch(() => null);
    check(
      'the viewer closes when the sharer ends it',
      closed?.reason === 'peer-ended',
      closed?.reason,
    );
    await Promise.race([viewer.exited, sleep(5_000)]);
    check('the viewer process exits', viewer.child.exitCode !== null);
    stopAll(sharer, viewer);
  }

  log('check', 'B: the viewer closes first');
  {
    const { sharer, viewer } = await pair();
    viewer.send({ cmd: 'end' });
    const closed = await sharer.wait((e) => e.event === 'closed', 15_000).catch(() => null);
    check('the sharer ends when the viewer leaves', closed?.reason === 'left', closed?.reason);
    stopAll(sharer, viewer);
  }

  log('check', 'C: nobody connects');
  {
    const sharer = launch('sharer', [
      'share',
      '--peer',
      'Check Colleague',
      '--control',
      'view',
      '--wait',
      '5',
    ]);
    await sharer.wait((e) => e.event === 'ready');
    const closed = await sharer.wait((e) => e.event === 'closed', 15_000).catch(() => null);
    check(
      'the sharer gives up when nobody connects',
      closed?.reason === 'no-viewer',
      closed?.reason,
    );
    stopAll(sharer);
  }

  log('check', 'D: a wrong password never gets in');
  {
    const sharer = launch('sharer', [
      'share',
      '--peer',
      'Check Colleague',
      '--control',
      'view',
      '--wait',
      '12',
    ]);
    const ready = await sharer.wait((e) => e.event === 'ready');
    const viewer = launch('viewer', ['view']);
    viewer.send({
      cmd: 'connect',
      ticket: ready.ticket,
      password: 'definitely-not-it',
      peer: 'Check Sharer',
      self: 'Check Viewer',
      screens: [],
    });
    const outcome = await Promise.race([
      viewer.wait((e) => e.event === 'connected', 14_000).then(() => 'connected'),
      viewer.wait((e) => e.event === 'closed', 14_000).then((e) => `closed:${e.reason}`),
    ]).catch((e) => e.message);
    const attendee = sharer.events.some((e) => e.event === 'attendee');
    check(
      'a wrong password is refused, and the sharer never sees an attendee',
      outcome !== 'connected' && !attendee,
      `viewer: ${outcome}`,
    );
    stopAll(sharer, viewer);
  }
  log('check', 'E: who is connected with Remote Desktop Connection');
  {
    const out = execFileSync(exe, ['sessions'], { encoding: 'utf8', timeout: 15_000 });
    const line = out.split(/\r?\n/).find((l) => l.trim().startsWith('{')) ?? '{}';
    const answer = JSON.parse(line);
    const sessions = answer.sessions ?? [];
    check(
      'the helper answers with one line listing the sessions',
      answer.event === 'sessions' &&
        Array.isArray(sessions) &&
        sessions.every((s) => s.state === 'active' || s.state === 'disconnected'),
      `${sessions.length} session(s)`,
    );
    // Windows' own `qwinsta` names a session "rdp-tcp#N" while a client is connected to it.
    const listed = execFileSync('qwinsta', { encoding: 'utf8', timeout: 15_000 });
    const connected = (listed.match(/^\s*>?\s*rdp-tcp#\d+/gim) ?? []).length;
    check(
      'it agrees with qwinsta about how many clients are connected',
      sessions.filter((s) => s.state === 'active').length === connected,
      `${connected} connected`,
    );
  }
  log('check', 'F: the picture keeps the shape of the shared screen, at any window size');
  {
    const sharer = launch('sharer', ['share', '--peer', 'Check Colleague', '--control', 'view']);
    const ready = await sharer.wait((e) => e.event === 'ready');
    const viewer = launch('viewer', ['view', '--debug']);
    viewer.send({
      cmd: 'connect',
      ticket: ready.ticket,
      password: ready.password,
      peer: 'Check Sharer',
      self: 'Check Viewer',
      screens: ready.screens,
    });
    await viewer.wait((e) => e.event === 'connected');
    // The size of what is shared arrives a moment after connecting; the last one is the real one.
    await sleep(2500);
    const shared = [...viewer.events].reverse().find((e) => e.event === 'size');
    const layouts = () => viewer.events.filter((e) => e.what === 'layout').map((e) => e.detail);
    const parse = (text) => {
      const m = /area=(\d+)x(\d+) picture=(\d+)x(\d+) at (-?\d+),(-?\d+) fit=(\w+)/.exec(
        text ?? '',
      );
      return m && { aw: +m[1], ah: +m[2], pw: +m[3], ph: +m[4], fit: m[7] === 'True' };
    };
    const ratio = shared ? shared.w / shared.h : 0;
    check(
      'the viewer reports the size of the shared screen',
      Boolean(shared),
      shared && `${shared.w}x${shared.h}`,
    );
    const sizes = [
      [1000, 700],
      [600, 900],
      [1400, 500],
      [900, 900],
    ];
    let allFit = true;
    let worst = 0;
    for (const [w, h] of sizes) {
      viewer.send({ cmd: 'resize', w, h });
      await sleep(900);
      const l = parse(layouts().at(-1));
      const deviation = l ? Math.abs(l.pw / l.ph - ratio) / ratio : 1;
      worst = Math.max(worst, deviation);
      // Within a pixel of rounding, never stretched, and it fills one side of the area.
      const touches = l && (l.pw >= l.aw - 1 || l.ph >= l.ah - 1);
      if (!l || !l.fit || deviation > 0.02 || !touches || l.pw > l.aw || l.ph > l.ah)
        allFit = false;
    }
    check(
      'fit to window: the picture is never stretched, whatever the window',
      allFit,
      `worst ${(worst * 100).toFixed(2)} % off`,
    );
    viewer.send({ cmd: 'fit', on: false });
    await sleep(900);
    const actual = parse(layouts().at(-1));
    check(
      'actual size: one pixel for one pixel, in the shape of the shared screen',
      Boolean(actual) && !actual.fit && actual.pw === shared?.w && actual.ph === shared?.h,
      actual && `${actual.pw}x${actual.ph}`,
    );
    stopAll(sharer, viewer);
  }

  log('check', 'G: the area around the picture follows the theme');
  {
    const colours = {};
    for (const theme of ['dark', 'light']) {
      const sharer = launch('sharer', ['share', '--peer', 'Check Colleague', '--control', 'view']);
      const ready = await sharer.wait((e) => e.event === 'ready');
      const viewer = launch('viewer', ['view', '--debug']);
      viewer.send({
        cmd: 'connect',
        ticket: ready.ticket,
        password: ready.password,
        peer: 'Check Sharer',
        self: 'Check Viewer',
        screens: ready.screens,
        theme,
      });
      await viewer.wait((e) => e.event === 'connected');
      await sleep(1500);
      const last = viewer.events.filter((e) => e.what === 'layout').at(-1);
      colours[theme] = /back=(\d+),(\d+),(\d+)/
        .exec(last?.detail ?? '')
        ?.slice(1)
        .map(Number);
      stopAll(sharer, viewer);
    }
    const dim = (c) => (c ? (c[0] + c[1] + c[2]) / 3 : -1);
    check(
      'a dark theme gives a dark surround and a light theme a light one (never plain black)',
      dim(colours.dark) >= 0 &&
        dim(colours.dark) < 60 &&
        dim(colours.dark) > 0 &&
        dim(colours.light) > 200,
      `dark ${colours.dark}, light ${colours.light}`,
    );
  }
  log('check', 'H: the small picture of the screens');
  {
    const sharer = launch('sharer', ['share', '--peer', 'Check Colleague', '--control', 'view']);
    const ready = await sharer.wait((e) => e.event === 'ready');
    const viewer = launch('viewer', ['view', '--debug']);
    // Three screens laid out as on a desk (the PC running this check may have one or two).
    const screens = [
      { w: 1920, h: 1080, primary: true, x: 0, y: 0 },
      { w: 1920, h: 1080, primary: false, x: 1920, y: 0 },
      { w: 1280, h: 1024, primary: false, x: -1280, y: 56 },
    ];
    viewer.send({
      cmd: 'connect',
      ticket: ready.ticket,
      password: ready.password,
      peer: 'Check Sharer',
      self: 'Check Viewer',
      screens,
    });
    await viewer.wait((e) => e.event === 'connected');
    await sleep(1500);
    viewer.send({ cmd: 'map', on: true });
    const opened = await viewer.wait((e) => e.what === 'map', 5_000).catch(() => null);
    check(
      'the toolbar button opens the small picture, with every screen in it',
      /screens=3 selected=-1/.test(opened?.detail ?? ''),
      opened?.detail,
    );
    // Windowless and compact: just the screens (no title bar or frame), and three screens get
    // more room than two would.
    const size = /size (\d+)x(\d+)/.exec(opened?.detail ?? '');
    const [mw, mh] = size ? [Number(size[1]), Number(size[2])] : [0, 0];
    check(
      'the small window is only its screens, and wider for three screens',
      mw >= 200 && mw <= 480 && mh >= 50 && mh <= 180,
      `${mw}x${mh}`,
    );
    // The small picture is there from the start (the checks' own 'map on' only asks again).
    check(
      'the small picture of the screens is open from the start',
      /visible=True/.test(opened?.detail ?? ''),
      opened?.detail,
    );
    viewer.send({ cmd: 'pick', index: 1 });
    const picked = await viewer
      .wait((e) => e.event === 'screen' && e.index === 1, 5_000)
      .catch(() => null);
    check('choosing a screen there is the same choice as in the menu', Boolean(picked));
    // Live pictures of the other screens: the sharing helper makes them (here, on request: this
    // PC may have one screen) and the viewer draws what arrives, in every screen but the one
    // being looked at.
    sharer.send({ cmd: 'thumbs-now' });
    const sent = await sharer
      .wait((e) => e.event === 'thumbs' && Array.isArray(e.shots) && e.shots.length > 0, 8_000)
      .catch(() => null);
    check(
      'the sharing PC sends small pictures of its screens',
      Boolean(sent) &&
        String(sent.shots[0].jpeg).length > 200 &&
        String(sent.shots[0].jpeg).length <= 40_000,
      sent
        ? `${sent.shots.length} picture(s), ${String(sent.shots[0].jpeg).length} characters`
        : 'none',
    );
    viewer.send({ cmd: 'pick', index: 0 });
    await sleep(300);
    viewer.send({ cmd: 'selfthumb', index: 1 });
    const live = await viewer
      .wait((e) => e.what === 'map' && /live=[1-9]/.test(e.detail ?? ''), 5_000)
      .catch(() => null);
    check(
      'the viewer draws what arrives for the screens it is not looking at',
      Boolean(live),
      live?.detail,
    );
    const file = join(tmpdir(), `intercom-map-${process.pid}.png`);
    viewer.send({ cmd: 'mapsnap', path: file });
    const kept = await viewer.wait((e) => e.what === 'mapsnap', 5_000).catch(() => null);
    check(
      'the screens not being looked at keep their last picture (not greyed out)',
      /kept=3/.test(kept?.detail ?? ''),
      kept?.detail,
    );
    await sleep(1500);
    check(
      'the small window draws itself (a picture of the screens, not an empty box)',
      existsSync(file) && statSync(file).size > 1500,
      existsSync(file) ? `${statSync(file).size} bytes` : 'no file',
    );
    try {
      rmSync(file, { force: true });
    } catch {
      // Left in the temporary folder.
    }
    stopAll(sharer, viewer);
  }
} catch (err) {
  log('check', `ERROR ${err.message}`);
  results.push(false);
}

const passed = results.filter(Boolean).length;
console.log(`check-assist-helper: ${passed}/${results.length} checks passed`);
await sleep(500);
process.exit(passed === results.length && results.length > 0 ? 0 : 1);
