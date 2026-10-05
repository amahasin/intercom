# Decisions

One entry per non-obvious choice: **decision**, _reason_, ~~alternative rejected~~.
Newest milestone last. Owner decisions from plan section 16 stand at their assumed defaults
(Electron, no database encryption, public teams allowed, keep messages forever, English only
with strings externalised) until the owner says otherwise.

## Pinned versions (M0, 2026-10-05)

Exact versions are locked in `pnpm-lock.yaml` (`saveExact: true`).

| Concern             | Package                     | Version                                           |
| ------------------- | --------------------------- | ------------------------------------------------- |
| Runtime             | Node.js (dev and CI)        | 24.x (developed on 24.15.0)                       |
| Package manager     | pnpm                        | 11.22.0                                           |
| Shell               | electron                    | 44.5.1 (Chromium 152, Node 24.21)                 |
| Language            | typescript                  | 6.0.3                                             |
| UI                  | react / react-dom           | 19.3.0                                            |
| UI                  | @fluentui/react-components  | 9.74.9                                            |
| UI                  | @fluentui/react-icons       | 2.0.343                                           |
| UI state            | zustand                     | 5.0.15                                            |
| Long lists          | @tanstack/react-virtual     | 3.14.13 (used from M2)                            |
| Editor              | lexical / @lexical/react    | 0.52.0 (used from M2)                             |
| Storage             | better-sqlite3              | 13.0.3 (SQLite 3.53.4, FTS5)                      |
| Certificates        | @peculiar/x509              | 2.1.0 (+ reflect-metadata 0.2.2)                  |
| Peer transport      | ws                          | 8.22.0 (used from M1)                             |
| Schemas             | zod                         | 4.6.5                                             |
| Safety phrase words | @scure/bip39                | 2.4.0 (wordlist only)                             |
| Shared canvas       | yjs                         | 13.6.33 (used from M5)                            |
| Build               | vite / @vitejs/plugin-react | 8.3.2 / 6.1.1                                     |
| Installer           | electron-builder            | 26.15.3                                           |
| Tests               | vitest / @playwright/test   | 5.0.3 / 1.63.0                                    |
| Lint                | eslint / typescript-eslint  | 10.12.0 / 8.71.0                                  |
| Host relay          | mediasoup                   | not yet pinned; added in M6 with its native build |

## M0

**TypeScript 6.0.3, not 7.0.**
_typescript-eslint 8.71 supports TypeScript below 6.1 only, and the lint rules are what enforce the process boundaries._
~~TypeScript 7.0 (native port) without type-aware linting.~~

**better-sqlite3's bundled N-API prebuilds; no electron-rebuild, no C++ toolchain.**
_Version 13 ships `prebuilds/win32-{x64,arm64}.node` against the stable N-API, so one binary loads in Node (tests, sim) and in Electron's utility process. Its install-time node-gyp step is disabled in `allowBuilds`._
~~Rebuilding for the Electron ABI, which would break the bare-Node test runs or require two copies.~~

**Workspace libraries run from TypeScript source, with no build step.**
_`erasableSyntaxOnly` plus `.ts` import extensions let Node 24 strip types natively, so `packages/core` runs as a bare Node process for tools/sim exactly as written; Vite bundles the same sources for the app._
~~Compiling each package to `dist/` with project references, or running through tsx.~~

**safeStorage is reached from the core through a `KeyProtector` interface and an RPC to the main process.**
_safeStorage exists only in Electron's main process, and the core must import no Electron code. Only the sealed blob crosses the process boundary at rest. The core never asks main to persist anything._
~~Generating and holding the key in the main process, which would split identity across two processes.~~

**Tests and sim use an `insecure-test` key scheme that the app refuses to load.**
_Bare Node has no DPAPI wrapper without native code. The key file records its scheme, so a test key can never be loaded by the app._
~~Calling DPAPI through PowerShell from Node, which is slow and still not what the app uses.~~

**Each profile gets its own Chromium userData folder.**
_It isolates caches and `Local State` (which holds safeStorage's DPAPI-wrapped key), and scopes the single-instance lock per profile, so `--profile=alice` and `--profile=bob` run side by side._
~~One shared userData with a custom lock file.~~

**The renderer is served from a privileged `officemesh://app/` scheme.**
_`'self'` in the CSP then means exactly the app bundle, the handler refuses path traversal, and no `file://` access is granted._
~~Loading `file://` URLs.~~

**CSP allows `'unsafe-inline'` for styles only.**
_Fluent UI v9's CSS-in-JS (Griffel) injects `<style>` elements at runtime. Scripts remain `'self'` only._
~~Build-time CSS extraction for Griffel, which is not supported for every Fluent component.~~

**The session cancels every http, https, ws and wss request.**
_This enforces "LAN only" below the CSP, so even a mistaken dependency cannot reach the internet from the renderer. Peer traffic never goes through the renderer._
~~Relying on the CSP alone.~~

**userId is the lowercase RFC 4648 base32 encoding (no padding) of the first 20 bytes of SHA-256 over the SPKI DER public key.**
_It is a fixed 32 characters, safe in file names and URLs, and the SPKI DER is the canonical public key form that both Node and X.509 produce._
~~Hashing the raw EC point, which needs a custom encoder.~~

**Signatures are ECDSA P-256/SHA-256 in IEEE P1363 form (r||s), base64url, over canonical JSON (sorted keys, no whitespace), verified over the record as received.**
_A fixed 86-character signature fits the 512-byte beacon. Verifying before schema parsing means fields added by newer versions do not break older peers' signature checks._
~~DER signatures, which vary in length; signing a schema-parsed copy, which would strip unknown fields.~~

**The safety phrase is six words from the BIP-39 English list, taking 66 bits of a domain-separated SHA-256 of the SPKI.**
_It is a vetted list of 2,048 unambiguous words, MIT-licensed through @scure/bip39, and 66 bits is ample for in-person comparison._
~~A hand-written word list, which risks duplicates and look-alike words.~~

**@peculiar/x509 needs `reflect-metadata` imported first.**
_Version 2 resolves its algorithm providers through tsyringe, which throws without the polyfill. It is imported at the top of `identity/certificate.ts`._
~~Writing ASN.1 by hand (forbidden by rule 6).~~

**The self-signed certificate has CN=userId, a 30-year validity, and EKU serverAuth plus clientAuth.**
_Peers ignore chains and compare only the key's hash to the expected userId, so a long validity avoids expiry. The single certificate serves both ends of mutual TLS._
~~Short-lived certificates with rotation, which buys nothing when trust is the key itself.~~

**The private key lives in `identity.key` beside the database, never inside it.**
_The database can be rebuilt or lost without losing the identity; on start-up the app recovers from the key file. If the database has an identity but the key is missing, the app refuses to start rather than silently becoming a new person._
~~Storing the sealed key in a database row.~~

**Database tables arrive with the milestone that needs them (M0: `identity`, `settings`).**
_Migrations are append-only; defining the M1 to M6 tables now would freeze guesses._
~~Creating every table from plan section 8 in migration 1.~~

**Wire `type` and event `type` are free strings in the envelope; the catalogue of known types lives in `WIRE_TYPES` and `EVENT_TYPES`.**
_Unknown types must be ignored, not fatal, during mixed-version rollout. Body schemas are added per milestone._
~~A closed enum, which would make older peers reject newer messages outright.~~

**The default display name comes from PowerShell (AccountManagement display name, then the ADSI FullName), falling back to the login name, on first run only.**
_Node has no API for the account's full name. The roughly 300 ms cost is paid once per profile, and UTF-8 output keeps non-Latin names intact._
~~Native addons for GetUserNameEx.~~

**Themes use Fluent's web light and dark themes, plus `createHighContrastTheme()`.**
_They follow Windows through `prefers-color-scheme` and `forced-colors`, and avoid importing third-party product-branded theme exports (rule 10)._
~~Product-named theme exports.~~

**Electron fuses are hardened in the packaged app (no RunAsNode, no NODE_OPTIONS, no inspector, asar integrity, asar-only).**
_This shrinks the attack surface of a binary installed on every office PC. As a consequence Playwright cannot attach to the packaged build, so `tools/scripts/smoke-packaged.mjs` checks it instead and the e2e suite runs the unpacked build._
~~Leaving the fuses at their defaults.~~

**The no-network-origin check has an explicit allowlist with a reason per entry.**
_Bundles contain URL-shaped identifiers that are never fetched (XML namespaces, JSON-Schema `$schema` IDs, React's error-decoder text, Zod's local IPv6 parse, and our own block-list patterns). Anything else fails the build._
~~Banning every URL-shaped string, which would forbid React and Zod.~~

**Installers are unsigned until the office provides a code-signing certificate.**
_Plan section 15. Windows SmartScreen will show "Windows protected your PC": choose More info, then Run anyway. This is documented in `manual-test.md`._
~~A self-signed code-signing certificate, which SmartScreen treats as unsigned anyway.~~

**Libraries for M2 to M5 (lexical, @tanstack/react-virtual, yjs) are pinned now but not imported; mediasoup is deferred to M6.**
_Plan section 3 asks for versions to be pinned at M0. mediasoup needs a native worker build that should be pinned and tested when it is first used._
~~Pinning mediasoup now, untested.~~
