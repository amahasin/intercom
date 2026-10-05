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

## M1

**A direct conversation's ID is derived from the two userIds: base32 of SHA-256 over a domain tag and the sorted pair, truncated to 20 bytes.**
_Either person can start the chat, even while the other is offline, and both arrive at the same ID without coordinating._
~~A random ID announced by whoever writes first, which needs a merge rule when both start at once.~~

**Delivery is tracked in an `acks` table (what each member holds of each author's events); the outbox is derived from it.**
_One mechanism covers both delivery status ("Delivered") and what is still owed to a member. A `sync.summary` from a peer raises acks too, so status is correct after a restart._
~~A separate outbox table of queued sends per recipient, which must be kept consistent with the log.~~

**Events and profiles are stored and resent exactly as received (`events.json`).**
_Signatures cover the record as signed, including fields a newer version may add, so a forwarding peer must not re-serialise a parsed copy._
~~Storing parsed columns only, and rebuilding the JSON for resend.~~

**Out-of-order events wait in memory (up to 5,000 per conversation and author); only gap-free runs are stored.**
_Plan section 8, rule 1. Keeping gaps out of the database means `MAX(seq)` is always the contiguous head that sync summaries report._
~~Storing out-of-order events with a "pending" flag.~~

**`sync.events` batches stop at 500 events or about 240 KB, and at 2,000 events per summary. A `more` flag makes the receiver send a fresh summary to pull the rest.**
_This keeps every frame under the 256 KB limit and every reply inside the per-link cap, without per-link sync cursors._
~~Push-based continuation, which needs sender-side state per link.~~

**Offline detection: a beacon silence of 15 s marks a peer offline unless an open link answers a 3 s probe. A link coming up marks a peer online.**
_This meets "power loss shows Offline within 20 s" even with a link open (15 + 1 + 3). Beacons filtered by the network do not hide a peer whose link works._
~~Relying on link keepalive (2 missed pongs = 30 s or more), which exceeds the 20 s budget.~~

**A peer's address only changes after its current one has been silent for 10 s.**
_Beacons arrive on every interface (LAN, VPN, Hyper-V), so without stickiness the stored address would flip on every beacon._
~~Always using the latest source address.~~

**Profile fetches run at most 4 at a time. After a failure they back off 30 s, then 1, 2, 4 minutes and so on, capped at 10 minutes, on top of the link manager's 1–30 s reconnect backoff.**
_A PC whose beacons arrive but whose TCP port is blocked would otherwise be dialed every 30 s just for its profile. This was measured: 200 such peers took beacon handling from 0.8% to 3.5% of a core._
~~Retrying on every beacon after the 30 s link backoff.~~

**The TLS client secure context is built once per transport.**
_Parsing the PEM key and certificate on every dial was the largest cost in the 200-peer CPU test._
~~Passing `key`/`cert` to every `WebSocket` dial (ws forwards `secureContext` to `tls.connect`; its types just omit it).~~

**TLS is 1.3 only, with `rejectUnauthorized: false` and our own check that the peer's key hashes to the expected userId. Both sides check: the dialer in `upgrade` before the socket opens, the listener before `handleUpgrade`, and the `hello` userId must match the certificate.**
_Certificates are self-signed by design; the userId is the trust anchor._
~~CA-style chain validation, which would need an issuer.~~

**On close, the UDP driver waits up to 500 ms for in-flight sends.**
_Closing a dgram socket cancels queued sends, which silently dropped the quit `bye` beacon. The end-to-end test caught it: Offline after quit took 15 s instead of 0.2 s._
~~Fire-and-forget, then close.~~

**Firewall rules are scoped to the program, inbound UDP 47800 and TCP 47801, on Private and Domain profiles only, in a rule group named OfficeMesh.**
_This follows plan section 6. Scoping by program means a dev build and an installed build keep separate rules. The check runs unelevated (`Get-NetFirewallApplicationFilter`, about 1.4 s); the fix runs `firewall.ps1` through one elevated `Start-Process -Verb RunAs`. The installer does the same with `ExecShellWait runas`, skipped for silent `/S` installs (IT runs the script)._
~~Port-only rules, which would open the ports for any program.~~

**Auto-away applies to Available and Busy; Do not disturb and Be right back are kept while idle or locked.**
_A user who chose DND or BRB made an explicit statement that idleness should not override._
~~Away overriding every state.~~

**A newcomer using one's own display name is flagged "New device or unverified", as is one using a name already known under another key.**
_Impersonating the person at the keyboard is the most direct attack. Two profiles on one Windows account trigger it (expected; the end-to-end test accepts the flag)._
~~Comparing only against other peers.~~

**Test isolation flags: `--discovery-port`, `--link-port=0`, `--lan=loopback` and `--firewall-status=ok|missing|public`.**
_End-to-end and integration runs never beacon on, or accept connections from, the real office LAN, and never prompt for UAC._
~~Running tests on the production ports, which interferes with real instances and colleagues.~~

**Core CPU in end-to-end tests is measured from `cumulativeCPUUsage`, not `percentCPUUsage`.**
_On this 32-thread PC, `percentCPUUsage` reported 0.04% for a process using 1.42% of one core: it is normalised across all cores._
~~`percentCPUUsage`, which hides overages on many-core PCs.~~

**The profile card's popover surface is rendered only while it is open.**
_With Fluent UI 9.74, the exit motion stalled when the card's own content changed as it closed (on Accept), leaving a closed card on screen._
~~Relying on the popover's presence motion.~~

**Avatars and status-message expiry are deferred to M2.**
_Avatars need the image pipeline that arrives with file sharing. The schema already carries `avatarHash` and `statusExpiresAt`, so no wire change is needed later._
~~A one-off avatar transfer path now.~~
