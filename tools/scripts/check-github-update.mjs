// Asks GitHub, for real, what the update check would find for a given app version:
//   node tools/scripts/check-github-update.mjs <owner/repo> <current version> [x64|arm64]
// Prints the release it would offer (or "nothing newer"). Reads only; downloads nothing.
import { findGithubRelease } from '../../packages/core/src/updates/github.ts';

const [repo = 'amahasin/intercom', current = '0.0.0', arch = 'x64'] = process.argv.slice(2);
const release = await findGithubRelease({
  repo,
  current,
  arch,
  userAgent: `InterCom-check/${current}`,
});
console.log(release ? JSON.stringify(release, null, 2) : 'nothing newer');
