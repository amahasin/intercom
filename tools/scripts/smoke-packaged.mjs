// Smoke-tests the packaged app (fuses disable the inspector, so Playwright cannot attach):
// launch OfficeMesh.exe with a throwaway profile and wait until the core, running in its
// utility process with the bundled native SQLite binding, has created a sealed identity.
// Usage: node tools/scripts/smoke-packaged.mjs [path\to\OfficeMesh.exe]
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const exe = resolve(process.argv[2] ?? 'apps/desktop/release/win-unpacked/OfficeMesh.exe');
if (!existsSync(exe)) {
  console.error(`smoke: ${exe} not found; run pnpm dist first`);
  process.exit(2);
}

const root = mkdtempSync(join(tmpdir(), 'officemesh-smoke-'));
const profileDir = join(root, 'smoke');
// Stay on a private loopback LAN with its own ports, and skip the firewall query.
const lan = ['--lan=loopback', '--discovery-port=47990', '--link-port=0', '--firewall-status=ok'];
const child = spawn(exe, ['--profile=smoke', `--data-root=${root}`, ...lan], { stdio: 'ignore' });
let exited = null;
child.on('exit', (code) => (exited = code));

const deadline = Date.now() + 30_000;
let ok = false;
let detail = 'timed out waiting for identity';
while (Date.now() < deadline) {
  if (exited !== null) {
    detail = `app exited early with code ${exited}`;
    break;
  }
  const keyPath = join(profileDir, 'identity.key');
  if (existsSync(keyPath) && existsSync(join(profileDir, 'officemesh.db'))) {
    try {
      const key = JSON.parse(readFileSync(keyPath, 'utf8'));
      ok = key.scheme === 'safeStorage';
      detail = ok ? 'identity sealed with safeStorage' : `unexpected key scheme ${key.scheme}`;
      // M6: the core keeps a log file in the profile.
      const log = join(profileDir, 'logs', 'officemesh.log');
      if (ok && !(existsSync(log) && readFileSync(log, 'utf8').includes('core started'))) {
        ok = false;
        detail = 'no core log file';
      }
      break;
    } catch {
      // File mid-rename; retry.
    }
  }
  await new Promise((r) => setTimeout(r, 250));
}

if (exited === null) {
  try {
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    // Already gone.
  }
}
await new Promise((r) => setTimeout(r, 500));
rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

// M6: x64 builds carry the meeting relay worker, unpacked from the archive.
const worker = join(exe, '..', 'resources', 'relay', 'mediasoup-worker.exe');
if (ok && !exe.includes('arm64')) {
  if (existsSync(worker)) detail += '; relay worker present';
  else {
    ok = false;
    detail = `relay worker missing at ${worker}`;
  }
}

console.log(`smoke: ${ok ? 'PASS' : 'FAIL'} - ${detail}`);
process.exit(ok ? 0 : 1);
