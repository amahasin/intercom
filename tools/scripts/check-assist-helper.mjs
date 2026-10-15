// Checks the remote help helper (intercom-assist.exe) on this PC: a sharing helper and a viewing
// helper are started and connected to each other, the way InterCom's main process does it.
//
//   node tools/scripts/check-assist-helper.mjs [path\to\intercom-assist.exe]
//
// It needs a Windows desktop (the helper opens windows, for a few seconds each) and cannot run in
// a build agent without one. The default path is the helper that `pnpm build` makes; for an
// installed or unpacked build, pass resources\intercom-assist.exe from it. The sharing side runs
// view-only, so nothing here can control the PC it runs on. Exit code 0: every check passed.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
} catch (err) {
  log('check', `ERROR ${err.message}`);
  results.push(false);
}

const passed = results.filter(Boolean).length;
console.log(`check-assist-helper: ${passed}/${results.length} checks passed`);
await sleep(500);
process.exit(passed === results.length && results.length > 0 ? 0 : 1);
