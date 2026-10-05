// Fails if a third-party product name appears in the repository (plan rule 17.10).
// Scans files tracked by git (or every non-ignored file before the first commit).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const FORBIDDEN = [/microsoft\s+teams/i, /\bms\s*teams\b/i, /teams\.microsoft/i];
const SKIP = [
  /^pnpm-lock\.yaml$/,
  /\.(png|ico|jpg|webp|woff2?)$/i,
  /^tools\/scripts\/check-branding\.mjs$/,
];

const list = (args) =>
  execFileSync('git', args, { encoding: 'utf8' })
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);

const files = [
  ...new Set([...list(['ls-files']), ...list(['ls-files', '--others', '--exclude-standard'])]),
];
const hits = [];
for (const file of files) {
  if (SKIP.some((s) => s.test(file))) continue;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  text.split('\n').forEach((line, i) => {
    if (FORBIDDEN.some((p) => p.test(line)))
      hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
  });
}

if (hits.length > 0) {
  console.error('check-branding: third-party product names found:');
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log(`check-branding: ${files.length} files clean.`);
