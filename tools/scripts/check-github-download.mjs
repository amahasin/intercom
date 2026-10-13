// Downloads the installer the update check would offer, the way the app does (GitHub hosts only,
// size and SHA-256 checked), into a temp file, and removes it:
//   node tools/scripts/check-github-download.mjs <owner/repo> <current version> [x64|arm64]
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadInstaller, findGithubRelease } from '../../packages/core/src/updates/github.ts';

const [repo = 'amahasin/intercom', current = '0.0.0', arch = 'x64'] = process.argv.slice(2);
const userAgent = `InterCom-check/${current}`;
const release = await findGithubRelease({ repo, current, arch, userAgent });
if (!release) {
  console.log('nothing newer');
  process.exit(0);
}
const file = join(tmpdir(), 'intercom-download-check', release.asset.name);
let last = -1;
const started = Date.now();
await downloadInstaller({
  release,
  file,
  userAgent,
  progress: (received, total) => {
    const pct = Math.floor((received * 100) / total / 25) * 25;
    if (pct !== last) {
      last = pct;
      console.log(`${pct}%`);
    }
  },
});
console.log(
  `ok: ${release.asset.name}, ${(release.asset.size / 2 ** 20).toFixed(1)} MB, size and SHA-256 match, in ${((Date.now() - started) / 1000).toFixed(1)} s`,
);
rmSync(file, { force: true });
