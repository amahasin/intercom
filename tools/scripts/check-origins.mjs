// Fails if the built app contains an http:// or https:// origin (plan rule 17.4).
// Usage: node tools/scripts/check-origins.mjs <dir> [<dir> ...]
//
// The allowlist holds strings that look like URLs but are never fetched. Each entry
// states why. Anything else, including a new dependency's CDN or telemetry endpoint,
// fails the build.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const ALLOWED = [
  {
    pattern:
      /^http:\/\/www\.w3\.org\/(2000\/svg|1999\/xlink|1999\/xhtml|XML\/1998\/namespace|1998\/Math\/MathML|2000\/xmlns\/?)$/,
    reason: 'XML namespace identifiers used by React DOM',
  },
  {
    pattern: /^https?:\/\/json-schema\.org\/draft[-/\w.]*\/schema#?$/,
    reason: 'JSON Schema $schema identifiers emitted by Zod',
  },
  {
    pattern: /^https:\/\/react\.dev\/errors\/$/,
    reason: 'React production error text (displayed, never requested)',
  },
  {
    pattern: /^http:\/\/\[\$\{\w+\}\]$/,
    reason: "Zod's IPv6 validator parses new URL(`http://[${ip}]`) locally",
  },
  {
    pattern: /^https?:\/\/\*\/\*$/,
    reason: 'our own session filter that blocks all http(s) requests',
  },
  {
    pattern: /^https:\/\/lexical\.dev\/docs\/error$/,
    reason: 'Lexical builds this URL into production error text; never requested',
  },
  {
    pattern: /^https:\/\/github\.com\/yjs\/yjs\/issues\/438$/,
    reason: 'Yjs warning text about importing it twice (console only, never requested)',
  },
  {
    pattern:
      /^(http:\/\/www\.webrtc\.org\/experiments\/rtp-hdrext\/[\w-]+|http:\/\/www\.ietf\.org\/id\/draft-holmer-rmcat-transport-wide-cc-extensions-01|https:\/\/aomediacodec\.github\.io\/av1-rtp-spec\/#dependency-descriptor-rtp-header-extension)$/,
    reason:
      'RTP header extension identifiers in SDP (mediasoup-client, M6): names that look like URLs, never fetched',
  },
  {
    pattern:
      /^http:\/\/(www\.xfa\.org\/schema\/[\w./-]+|ns\.adobe\.com\/(xdp\/pdf\/|xdp\/|xfdf\/|xmpmeta\/)|www\.w3\.org\/(2000\/09\/xmldsig#|1999\/XSL\/Transform))$/,
    reason:
      'XML namespace identifiers in pdf.js (XFA forms, XFDF, XMP metadata; the built-in PDF viewer, M6.7). Names, never fetched; XFA is switched off',
  },
  {
    pattern: /^http:\/\/www\.apache\.org\/licenses\/LICENSE-2\.0$/,
    reason: 'Apache licence header text in pdf.js',
  },
  {
    pattern: /^(https:\/\/foo\.bar|http:\/\/example\.com)$/,
    reason:
      'pdf.js gives these to the URL parser as a base to tell a relative link from a bad one; never requested',
  },
  {
    pattern: /^http:\/\/\$\{\w+\}$/,
    reason:
      'pdf.js puts a scheme in front of a "www." link typed in a PDF; the viewer draws no links, and the session blocks http(s) anyway',
  },
  {
    pattern: /^https:\/\/api\.github\.com\/repos\/\$\{\w+\}\/releases\/latest$/,
    reason:
      'The update check (packages/core/src/updates/github.ts): the one request the app makes to the internet, on purpose, from the core process (the pages cannot reach it). Switched off in Settings; only GitHub hosts are followed',
  },
  {
    pattern: /^https:\/\/api\.github\.com\/repos\/\$\{\w+\}\/releases\/latest$/,
    reason:
      'The update check (packages/core/src/updates/github.ts): the one request the app makes to the internet, on purpose, from the core process (the pages cannot reach it). Switched off in Settings; only GitHub hosts are followed',
  },
  {
    pattern: /^https:\/\/\$\{\w+\}$/,
    reason: 'Lexical adds a scheme to a link the user typed; opened in the browser only if clicked',
  },
];

const TEXT_EXTENSIONS = new Set([
  '.js',
  '.cjs',
  '.mjs',
  '.html',
  '.css',
  '.json',
  '.svg',
  '.map',
  '.txt',
]);
const URL_PATTERN = /https?:\/\/[^\s"'`<>()\\,;]+/g;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (TEXT_EXTENSIONS.has(extname(name).toLowerCase())) yield path;
  }
}

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error('usage: check-origins.mjs <dir> [...]');
  process.exit(2);
}

const violations = [];
let scanned = 0;
for (const dir of dirs) {
  for (const file of walk(dir)) {
    scanned++;
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(URL_PATTERN)) {
      const url = match[0].replace(/[.:]+$/, '');
      if (!ALLOWED.some((a) => a.pattern.test(url))) {
        violations.push(`${relative(process.cwd(), file)}: ${url}`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`check-origins: ${violations.length} network origin(s) found in the built app:`);
  for (const v of [...new Set(violations)]) console.error(`  ${v}`);
  console.error(
    'Remove the dependency or, if the string is never fetched, add it to ALLOWED with a reason.',
  );
  process.exit(1);
}
console.log(`check-origins: ${scanned} files scanned, no network origins.`);
