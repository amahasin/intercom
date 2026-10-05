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

## M2

**Message text on the wire is a restricted Markdown subset (bold, italic, strike, code, code blocks, quotes, lists, links, `@[Name](userId)` mentions), not Lexical's JSON.**
_It is small, stable across Lexical versions, easy to validate, searchable as plain text, and rendered by our own parser into React elements (never innerHTML). Lexical is only the editor; it converts to and from this subset._
~~Lexical's serialised editor state, which ties the wire format to an editor library's internals.~~

**Materialisation is order-independent: last writer wins by HLC (author as tie-break) for edits, reactions and pins; deletes are final; an edit or delete stored before its post is applied when the post lands (indexed by `events.target_*`).**
_The live view and `rebuild` then produce identical tables whatever order events arrive in. The integration test checks byte equality after every message action._
~~Applying events only in arrival order, which diverges once events reach peers in different orders.~~

**Known event types with an invalid body are stored but not shown.**
_Rejecting them would leave a gap in the author's `seq`, and every later event from that author would wait forever._
~~Rejecting the event.~~

**Files are announced as `file.share` events carrying a `manifest`: the SHA-256 of the concatenated per-chunk SHA-256 list. The list itself is fetched from any holder with `file.manifest` (a wire type added under `files.v1`).**
_Every 1 MB chunk can then be verified on arrival against data the original sender signed, whichever member serves it. Putting 2,048 chunk hashes in the event would bloat the log._
~~Whole-file hash only, which detects corruption only after the full download.~~

**Downloads pull: up to 32 chunks in flight per holder, refilled when 16 have arrived, in 16-chunk `file.request`s. Chunks arrive as binary frames (16-byte transfer ID + offset), which are exempt from the 50 text-frames-per-second limit but accepted only if requested.**
_The first design (a request per chunk) tripped the plan's abuse limit at LAN speed: the holder banned the downloader for 60 s and the transfer stalled. Measured after the fix: 1 GB in about 13 s over the in-memory network, including a 3 s cable pull._
~~Raising the abuse limit.~~

**A corrupt chunk earns its holder a strike and is fetched again; three strikes drop the holder. A manifest that does not match the signed hash drops the holder at once.**
_One flipped bit should not cost the whole download, and a malicious holder should not be retried forever._
~~Failing the download.~~

**The chunk bitmap is persisted per chunk in `files.have`, and the `.part` file is written in place, so downloads resume after a restart. The test asserts no already-held chunk is fetched again. Stalled downloads re-ask holders every 5 s.**
_Plan section 10 requires resuming. Without the 5 s retry, a holder whose cable came back within the 15 s offline window never triggered a resume._
~~Restarting from zero.~~

**File stores are per PC (`%LOCALAPPDATA%\OfficeMesh\files`), shared by profiles on the same PC. Content addressing makes a second profile's copy instant.**
_This follows plan section 10. Simulated peers each get their own store so tests transfer for real._
~~One store per profile.~~

**Only members of a conversation where a file was shared may fetch it (`mayServe`). Forwarding a file adds the new conversation's members.**
_Plan section 8: non-members never receive private content._
~~Serving anyone who knows the hash.~~

**Downloaded files get `Zone.Identifier` (ZoneId=3, "from another computer"). Opening uses a hard link named `<sha8>\<safe name>`; executables are only revealed in Explorer.**
_SmartScreen and Office Protected View then apply (plan section 10), and peer-supplied names never form a path except through `safeFileName`._
~~Opening the content-addressed file directly, which has no extension.~~

**Images under 10 MB download automatically; senders attach a JPEG thumbnail (max 320 px, under 48 KB) made on their PC.**
_The receiver sees a preview at once, even if the image is not yet downloaded._
~~Server-side or receiver-side thumbnailing.~~

**Link previews are fetched by the sender while composing, only for hosts resolving entirely to private addresses, connecting to the checked address (no DNS rebinding), within 2.5 s and 512 KB. The result travels in the signed post.**
_The plan wants previews "limited to LAN-reachable pages". Recipients make no request, so reading a message never reveals the reader to the linked server._
~~Recipient-side fetching.~~

**Read receipts are `msg.read` events (upto HLC), sent for direct chats only, at most every 2 s per chat, and only when something unread was read. They can be switched off in Settings.**
_Plan section 10: direct chats and groups of up to 20; groups arrive in M3._
~~Per-message receipts.~~

**Notifications are decided in the core (DND lets only urgent through; muted and mentions-only levels; nothing for the chat on screen in a focused window), shown by main as Windows toasts with inline reply. Electron 44 supports `reply` on Windows.**
_The same rules apply whether or not the window exists._
~~Renderer-side notifications, which need a live window.~~

**The taskbar badge is drawn at runtime (a 32x32 BGRA disc with a 3x5 pixel font).**
_No image assets or font rendering are needed in the main process._
~~Shipping pre-rendered badge images.~~

**Closing the window hides it to the tray; Quit is in the tray menu. Start with Windows (`--hidden`) is registered only by installed builds.**
_Plan sections 10 and 15. A dev build would otherwise register `electron.exe` at sign-in._
~~Registering in every build.~~

**Development builds expose `globalThis.__officemeshTest` in the main process (recorded toasts, reply-to-toast, window visibility, unread).**
_Playwright cannot click Windows notifications. The hook drives the same main-process path as a real toast reply, and is absent from packaged builds._
~~Leaving inline reply untested.~~

**Search uses an external-content FTS5 table over `messages.plain` with triggers, prefix matching, AND of terms, and newest first.**
_Measured on 100,001 messages: rare word 0.4 ms, common words about 51 ms (target 200 ms)._
~~LIKE scans.~~

**Two Lexical strings are allowlisted by the origin gate:**

- **`https://lexical.dev/docs/error`**, which is error text.
- **`https://${url}`**, which Lexical uses to add a scheme to a typed link.

_Neither is ever requested by the app; links open in the browser only when clicked._
~~Patching Lexical.~~

## M3

**A group's or team's id is self-certifying: the first 20 bytes of SHA-256 over the genesis type, author and canonical body (which includes a random nonce), in base32. Channel ids hash the team id, the creating owner and a nonce, and the General channel's id hashes the team creator and the team nonce.**
_Anyone can check that a `group.create` or `team.create` really founded the conversation it names, and nobody can make a second genesis for an existing id. A channel cannot be claimed by an event from another team._
~~Random ids, which would let a forged genesis claim an existing conversation.~~

**Member lists carry each member's public key and name. A key is accepted only if it hashes to the userId it is listed for.**
_Members verify each other's signatures before they ever meet on a link (a new member may join while the author is offline), and a forged entry cannot attach a different key to someone's id._
~~Verifying only authors seen in beacons, which leaves events held until each author has been online.~~

**Membership is a timeline replayed from the group's or team's own membership and control events in HLC order (ties broken by author, then seq), applying plan section 8:**

- **Groups:** any current member adds, removes or renames; anyone may leave.
- **Teams:** only owners (at that point in the log) add, remove, change roles, rename the team and create, rename or archive channels. Anyone may leave. On a public team a non-member may add only themselves.

**An event counts only if its author was a member at its HLC. When a timeline's history changes, the affected conversations are re-materialised from the log.**
_The result depends on the set of events, not the order they arrive in, so peers that receive concurrent changes in different orders agree. Two owners renaming a channel at once resolve to the later rename everywhere._
~~Applying membership changes in arrival order, which diverges under concurrency; a designated admin peer, which the plan rules out.~~

**Events from someone who has never been a member, events whose key is unknown, and events for a conversation whose genesis has not arrived are held (up to 20,000 per conversation and 200 conversations) and retried whenever membership changes. A held `member.add` naming this PC lets its genesis be accepted although the genesis does not list it.**
_A member who was added later receives the history in any order. Until the timeline confirms the addition, the conversation shows as inactive._
~~Rejecting such events, which loses them when a membership event is still on its way.~~

**A live event goes to the members before and after it (so a removed member learns of the removal) with a `sentTo` list. A receiver forwards it once to members not yet reached.**
_A member that cannot reach the author still gets the event from whoever can (plan section 8)._
~~Flooding to every member on every hop.~~

**Anti-entropy has four triggers:**

- **Link up:** summaries are exchanged when a link comes up.
- **Pending:** every 10 s, peers that may lack our events get a summary.
- **Behind:** a peer that sees it lacks events asks for them (at most every 5 s per peer).
- **Gossip:** every 15 s each PC compares summaries with the next connected colleague in rotation.

**Summaries cover every conversation either side has shared with the peer. A current member gets everything; a former member gets events up to the moment they left.**
_The randomised test found three ways targeted sync alone fails to converge:_

- _A removed member never learnt of its removal._
- _A re-added member never learnt of its re-addition._
- _Two groups of peers whose links survived a silent outage never compared notes._

~~Exchanging summaries only on link up.~~

**A former member who was re-added after leaving also receives the membership events between their removal and that re-addition, never posts. A membership event that arrives ahead of its author's earlier events is kept in `sparse_events` and counts in the membership timeline; it moves to `events` once the gap fills.**
_The randomised test found a removed member re-added by an owner whom a concurrent change had already demoted. The member could not see the demotion, which came after its removal, so it believed it was still a member. Sending the events in between in full would leak posts, and an author's events otherwise have to arrive in sequence._
~~Sending a former member everything up to the re-addition; leaving the stale member believing it is in the conversation.~~

**Live events to the same peer within one task travel as one `event.batch` frame (capability `teams.v1`; single events and older peers still use `event.push`).**
_A burst such as 500 posts would otherwise exceed the 50 frames per second abuse limit and get the sender banned._
~~Raising the limit.~~

**Public teams are advertised in `hello` (up to 50, names only) and re-advertised with a repeated `hello` when they change. Joining fetches the team's control log from a member (`team.fetch`, up to 500 events), verifies it, then adds oneself. Channel history then arrives through normal sync.**
_Discovery needs no directory server and reveals only public teams. Older peers ignore a repeated `hello`._
~~A broadcast of team lists in beacons, which would grow every beacon.~~

**Standard channels follow the team's membership; private channels have their own member scope inside the team log, limited to team members. The General channel cannot be archived. An archived channel is read-only.**
_There is one log to replay for a team, and a member removed from the team leaves all its channels at the same HLC._
~~A separate membership log per channel.~~

**Threads are `msg.post` events with a `thread` reference to a root post. A channel's post list loads root posts only, with a reply count, and a thread loads on demand. An announcement is a root post with a headline.**
_It needs no new event types, and a long thread does not push other posts out of the list._
~~A separate reply event type.~~

**Poll votes are last-writer-wins per voter by HLC. A poll closes at the earliest `poll.close` by its author, and votes after the close do not count. The app refuses to vote on a poll it knows is closed; a vote cast concurrently with the close is dropped everywhere.**
_These rules are order-independent and survive `rebuild`._
~~Counting every vote ever cast.~~

**Read receipts are sent in direct chats and in groups of up to 20 people, never in channels.**
_This follows plan section 10._
~~Receipts everywhere.~~

**The randomised sync test runs 10 in-process peers, 2,000 random actions, random partitions and a random per-frame delay that keeps each link in order (as TCP does) but lets frames on different links overtake each other. Peers reuse the same identity keys (cached in the temp folder), so a seed replays exactly. `pnpm test` replays every seed in `tests/integration/fuzz-regressions.json` at full size plus two quick seeds. `pnpm test:fuzz` runs 100 seeds across worker processes and adds any failing seed to that file.**
_A full run takes about 9 minutes on 12 workers, too slow for every test run, while a failing seed must never be lost._
~~Random keys per run, which made failing seeds unreproducible.~~
