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

## M4

**Signaling lives in the core, media in the renderer.** The core rings and answers, keeps the call roster and history, and relays SDP and ICE over the peer link. The renderer owns the `RTCPeerConnection`s, in a call engine outside React, so media survives navigation.
_WebRTC exists only in Chromium, and the core must keep running without a window. Keeping the engine out of React means switching views never re-creates a connection._
~~Running WebRTC in the main process or a hidden window, which would need a second media path to the UI.~~

**The "call window" is a full-size stage inside the main window, which shrinks to a floating mini view when the user goes elsewhere in the app.**
_There is one renderer, one IPC client and one copy of the call state._
~~A separate BrowserWindow, which would need a second IPC client and a split call state.~~

**Every `call.sdp` is signed with the sender's identity key and carries the SDP's DTLS fingerprint. The receiver checks both the signature and that the fingerprint matches the SDP; ICE candidates travel unsigned over the authenticated link.**
_The encrypted media is bound to the colleague's identity (plan section 9). A candidate cannot redirect media to anyone who lacks the signed fingerprint's key._
~~Trusting the link alone for SDP.~~

**`iceServers` is empty, and Chromium's mDNS hiding of local addresses is switched off (`WebRtcHideLocalIpsWithMdns`), so peers exchange plain host candidates.**
_The plan needs host candidates only; mDNS names depend on multicast DNS, which some office networks block. Measured: a 1:1 call connects 373 ms after Accept._
~~Leaving mDNS candidates on.~~

**Connections use perfect negotiation:**

- **Polite peer:** the lower userId is the polite peer.
- **Who connects:** the later joiner opens the connection, creating an audio transceiver, then a camera transceiver.
- **Answering side:** the other side puts its tracks onto the transceivers the offer created.
- **Ordering:** call changes and signals are processed one at a time, so a candidate is never applied while its offer is still being set.

_Renegotiations from both sides (screen share started at the same instant: the test sees a rollback) resolve without deadlock._
~~Ad hoc offer and answer, which deadlocks on glare.~~

**Camera on and off swaps the camera sender's track (`replaceTrack`) and never renegotiates. The camera m-line stays `sendrecv`; others show the avatar from the roster's `video` flag.**
_Toggling direction instead worked 1:1, but after simultaneous toggles in a three-way call frames did not resume on one link. A track swap cannot collide._
~~Changing the transceiver direction on each toggle.~~

**A screen share is an extra `sendonly` video transceiver, reused for later shares:**

- Up to 1080p at 15 fps, with the `detail` content hint.
- A click-through magenta border marks the shared screen and is excluded from capture (`setContentProtection`).
- One sharer at a time: a newer share replaces the older one. Two starts within 2 s of each other count as simultaneous, and the higher userId keeps sharing.

_Starting and stopping a share renegotiates video only, so audio never stalls: the longest gap measured in incoming audio packets was 267 ms against a 250 ms sampling interval._
~~Replacing the camera track with the screen, which loses the camera.~~

**Each connection has a negotiated data channel carrying a 1 s heartbeat. Six seconds of silence drops the participant. The drop is gossiped in the roster, and the dropped PC's own call ends if it hears of it.**
_Plan M4: a pulled cable must remove the tile within 10 s. Measured: 6.9 s. ICE consent checks alone take about 30 s._
~~Waiting for ICE `failed`.~~

**The roster is replicated (`call.state`) with a version per entry. Only the owner changes their entry, except for a drop. The higher version wins, and at equal versions "left" wins.**
_Late joiners learn everyone from the invitation and connect to each; mute, camera, share, hold and speaking spread to all participants._
~~A central call owner.~~

**There is at most one call per PC. An invitation while in a call, in Do not disturb, or to a full call is declined at once with the reason (`busy`, `dnd`, `full`), and the caller sees it. A ring lasts 30 s.**
_Plan section 9._

- **Missed calls:** unanswered, cancelled while ringing, or auto-declined calls become a missed-call Activity item and a toast; Do not disturb gets no toast.
- **Presence:** while in a call, Available shows as Busy.

~~Ringing over Do not disturb.~~

**Mesh limits (plan section 9):**

- Video for up to 8 people, audio only up to 12.
- Above 4 people, video is sent at half resolution (360p, 600 kbps).
- Above 6, only the 4 most recent speakers send video. Recency comes from `lastSpokeAt` in the roster, so every PC agrees on who they are.

_Measured: an 8-person video call on one PC with 8 app instances stayed fully connected (7 links per PC, audio flowing) for the whole run._
~~Everyone sending 720p to everyone, which is 56 encoders in an 8-person call.~~

**Devices are watched during a call:**

- Every half second the engine checks the microphone's and (if on) the camera's track. One that is missing or has ended (unplugged, driver reset, taken by another app, or failed to open) is reopened every 3 s and swapped onto every connection.
- Each open is itself retried briefly on `NotFoundError`, `NotReadableError` and `AbortError`.
- A camera that fails to turn on stays "on" until the device opens.

_A camera released a moment ago reports itself missing while the capture service restarts. In the mesh test one PC's camera track ended mid-call and the PC went on sending a dead track._
~~Failing the toggle, or noticing nothing.~~

**In test builds started with `--fake-media`, the camera is a drawn test pattern (a canvas stream, 640x360 at 30 fps); the microphone is Chromium's synthetic one.**
_Chromium's synthetic capture device stopped for good in about half the two-app runs ("Requested device not found" from then on), which made call tests fail at random. Only the camera source differs; every WebRTC path is the same as with a real camera. Real cameras are covered by M4.1 to M4.4 on physical PCs._
~~Chromium's fake camera.~~

**The main window does not throttle in the background (`backgroundThrottling: false`).**
_Calls keep their heartbeats and media running while the window is hidden in the tray._

**Call history is a local `calls` table (one row per call). Calls left open by a crash are closed at the next start, as missed or cancelled.**

**System audio sharing (loopback capture) is not implemented in M4.**
_The plan marks it optional, and Electron offers it only through `setDisplayMediaRequestHandler`, which does not combine with the in-app picker._
~~Shipping it half-working.~~

**Tests:**

- `--fake-media` gives each app a drawn test-pattern camera and Chromium's synthetic microphone.
- A "cable pull" kills the app's whole process tree; killing only Electron's main process leaves the renderer sending media.
- The 8-person mesh test runs for `OFFICEMESH_MESH_MINUTES` minutes: 1 in `pnpm e2e`, 30 for the done-when check.

## M5

**A scheduled meeting is a `meeting.schedule` event in a conversation's log: a chat or channel the organiser picks, or a new meeting chat (a group) created for the invitees.**
_Invitees who are offline get it the way they get any message, from whoever is online when they return (the done-when check). There is no separate calendar store to keep in step._
~~A calendar database replicated on its own.~~

**Meeting rules:**

- **Occurrences:** occurrences step from the first one in local time (daily, weekdays or weekly, with an optional end date), and a meeting lasts at most a day.
- **Organiser control:** only the organiser updates (a whole new description, last change wins) or cancels (the series or one occurrence, never undone).
- **RSVPs:** last writer wins per person.
- **Storage:** RSVPs, cancellations and "meeting over" marks live in their own tables, so `rebuild` reproduces them.

_These rules are order-independent like the rest of the log._
~~Editing meetings with `msg.edit`, where a later edit would overwrite the meeting's cancellations.~~

**Reminders are a toast 15 minutes before each occurrence the user has not declined, once per occurrence (remembered across restarts), checked every 30 seconds by the core.**
_It works with the window closed, like message toasts._

**.ics export writes an RFC 5545 file to the Downloads folder (RRULE, EXDATE for cancelled occurrences, folded lines) and shows it in Explorer. ORGANIZER and ATTENDEE carry names with a `noreply@officemesh.invalid` address.**
_The format requires a calendar address, and an `.invalid` domain can never be mistaken for a real one._

**Meet now:**

- **Starting:** Meet now starts an open call in a chat or channel and posts a `call.started` card.
- **Joining:** someone joining sends `call.join` to the online members; whoever is in the meeting invites them, and the joiner accepts at once.
- **Staying open:** a meeting stays open while anyone is in it, even alone.
- **Ending:** the last person to leave posts `call.ended`, which turns the card into "Meeting ended".

_Joining reuses the invite, roster and signalling paths of M4. Measured: a fourth person joining a three-person meeting had every stream within 522 ms._
~~A meeting host that must stay online.~~

**A scheduled meeting's call id is derived from the meeting and the day. Two people who start it at once get the same id; when one sees the other's card, it asks to join, and an invitation to a call this PC is already in merges the two rosters.**
_There is never more than one meeting in progress for one occurrence._

**In-meeting controls:**

- **Organiser:** whoever starts the call is its organiser. Mute (one person or everyone), remove and spotlight are honoured only from the organiser; spotlight is a field on the organiser's own roster entry.
- **Roster flags:** raise hand and "recording" are optional roster fields, so M4 peers ignore them.
- **Reactions:** live reactions are ephemeral `call.reaction` messages.
- **Compatibility:** the new wire types need capability `calls.meet`.

_A participant's `call.control` is ignored by every PC, including one sent straight over the link (integration test)._

**The meeting chat is the conversation's own log, shown beside the call.**
_Plan section 9; messages stay in the chat after the meeting._

**Background blur:**

- **Pipeline:** MediaPipe's selfie segmenter, applied as an insertable-streams transform (`MediaStreamTrackProcessor` to `MediaStreamTrackGenerator`) on the camera track.
- **Cost:** segmentation runs on a 256x144 copy; the background is blurred at a quarter of the size and scaled up; the person is cut out of the full frame with the scaled-up mask. GPU delegate first, CPU as fallback.
- **Self-check:** it measures its own frame rate against the camera's (`track.stats`). Below 24 fps for 5 s, and behind the camera, it turns itself off with a notice.
- **Responsiveness:** it yields between frames, so a slow PC stays responsive.
- **Measured:** 29–30 fps at 720p on the development PC.

_Plan section 9 and the M5 done-when check. "Mid-range office laptop" must still be checked by hand (M5.3)._
~~Blurring the full 720p frame, which costs more than everything else per frame.~~

**MediaPipe ships inside the app:**

- **Files:** the SIMD WebAssembly runtime and the model `selfie_segmenter.tflite` (float16, 249,537 bytes, Apache 2.0, SHA-256 `191ac952…658b`), named explicitly; MediaPipe's own detection picks the non-SIMD build under our CSP.
- **CSP:** the CSP gains `'wasm-unsafe-eval'` (compiling bundled WebAssembly; `eval` of strings stays blocked) in both the header and the page's meta tag.
- **No telemetry:** MediaPipe's built-in usage logger, which posts to a Google endpoint every minute, is cut out at build time, and the build fails if that code changes.
- **Origin check:** the loader's comments, full of documentation links, are stripped when copied, so the origin check stays strict.

_Plan rule: no network dependency, and nothing downloaded at run time._
~~Allowlisting the telemetry URL and relying on the session's network block alone.~~

**Recording:**

- **Content:** MediaRecorder records a 1280x720 canvas showing what everyone sees (the grid, or the shared screen) plus every participant's audio mixed together.
- **Format:** MP4 (H.264 and AAC) when available, else WebM. Windows Media Player plays MP4 with no extra codecs, which the done-when check asks for (the plan suggested WebM).
- **Storage:** pieces go to the core every second and are appended to a file, so long recordings never sit in memory; when stopped, the file is shared to the meeting chat and plays inline.
- **Banner:** the recording banner comes from the recorder's roster entry, so everyone, including late joiners, sees it while it runs.

~~Recording only the recorder's own view.~~

**The app's protocol may serve completed `video/mp4` and `video/webm` files to the page, with byte ranges, and the scheme has the `stream` privilege.**
_Without it the recording in the chat could not play (`MEDIA_ERR_SRC_NOT_SUPPORTED`)._

**Whiteboard:**

- **Document:** a Yjs document per call (an array of items: strokes, rectangles, ellipses, text, sticky notes); strokes grow point by point as they are drawn.
- **Sync:** synced over a negotiated data channel (id 1) on each connection. Each side sends its whole state when the channel opens, then its own changes; updates are split into 64 KB pieces.
- **Export:** "Share as PNG" posts the board to the meeting chat.

_Everyone is connected to everyone, so no relaying is needed. Two people drawing at once end up with identical documents and identical pixels._
~~A whiteboard log in the conversation, which would grow with every pen movement.~~

**Test hooks in the renderer:** `officemeshBlurStats`, `officemeshWhiteboard`, and `__officemeshBlurDelayMs` (extra work per frame, to exercise blur's automatic switch-off). The synthetic test camera is now 720p.

## M6

**Host relay: when a meeting outgrows the mesh (9th person with video, 13th audio-only), it moves to a media relay run by one participant's core with mediasoup. Signaling becomes a star through the host over the existing peer links (`relay.request`, `relay.response`, `relay.notify`, capability `calls.relay`); media is WebRTC between each renderer and the host.**
_Plan section 9. Joining, roster changes, reactions and organiser controls all go through the host, so nobody needs a link to all 99 others; the roster stays versioned per person as in M4._
~~Every participant gossiping the roster to everyone (O(n²) messages at 100 people).~~

**The host's DTLS fingerprint reaches participants inside `relay.response` over the mutual-TLS link, so the media connection is bound to the host's identity; relayed calls carry no separate signed SDP.**
_The link already authenticates both ends; mediasoup does not produce an SDP to sign. The host can see the media of the meeting it relays (it is in the meeting); the About page says so._
~~End-to-end media encryption through the relay (insertable streams with a group key): not in the plan, and it would break the host's loudest-speaker selection.~~

**Who hosts:**

- **Choice:** the organiser if its PC is relay-capable, otherwise the strongest PC with a relay score above 0 (ties: lowest userId).
- **Score:** each participant's roster entry carries its relay score (optional field, so 0.5 peers ignore it).
- **Capable:** wired Ethernet of at least 1 Gbps (from `Get-NetAdapter`, no elevation), 8 or more logical cores, the x64 worker present, and Settings not set to "never". That scores 1,000 or more, and the meeting holds 100.
- **Otherwise:** a PC that can run the worker scores its core count, and the meeting is capped at 25. Joiners above the cap are declined as full.

_Everyone computes the same answer from the same roster, so a hand-over needs no election round._
~~An election protocol among participants (more messages, slower recovery).~~

**Hand-over:**

- **Trigger:** a participant whose link to the host drops and cannot be re-dialed, or that hears no host heartbeat (every 2 s) for 6 s, or that sees the host's own roster entry go to "left".
- **Next host:** it picks the next host from the roster, excluding failed ones, and raises the epoch.
- **New host's view:** the new host starts its relay seeded with the old roster; people who do not rejoin within 10 s are dropped.
- **Guard:** a would-be successor that still hears the old host (link up, heartbeat within 3 s) redirects the asker back instead of splitting the meeting.

_Measured: media flowing again 1.1–3.6 s after the host was killed (in-process test, 100-person load runs, and the real app with its process tree killed: 2.2 s)._
~~Waiting for the old host's link to time out (32 s).~~

**One mediasoup worker per core (up to 16), started as the meeting grows (12 people per router), with producers piped between routers. Each worker's WebRTC server listens on one fixed port (47802 and up); the installer adds firewall rules for `mediasoup-worker.exe` on UDP and TCP 47802–47817.**
_Plan section 9. A fixed port per worker needs one firewall rule, not a range of thousands; the relay worker is a separate program, so the existing rules for OfficeMesh.exe do not cover it._
~~Random ports per transport (needs a wide firewall hole).~~

**What each person receives:**

- **Audio:** every voice is consumed but only the loudest 3 flow, from an audio-level observer every 300 ms.
- **Video:** up to 9 cameras, the most recent speakers (paging for more), at 360p with up to 4 tiles and 180p above that, from 3 simulcast layers.
- **Unwatched cameras:** a camera nobody receives is paused at its sender.
- **Screen:** one screen share at a time, to everyone.
- **Large meetings:** above 25 people, newcomers join muted with their camera off.

_Plan section 9. Measured at 100 people: 2,822 consumers, about 350 Mbps out of the host._
~~Forwarding every stream (n² streams).~~

**Relay notifications to each participant are gathered for 50 ms and sent as one `batch` frame; clients resume consumers in batches too.**
_Joining a 100-person meeting brings a consumer for every voice and camera at once. As separate frames this broke the link's 50-frames-per-second abuse limit; the receiver banned the host's link and started a needless hand-over (seen in the first load runs)._
~~Raising the per-link frame limit (an M1 protection, and older peers would still enforce 50).~~

**ARM64 builds have no relay worker (mediasoup publishes no Windows ARM64 binary) and never host; they join relayed meetings as participants.**
_Building mediasoup's C++ worker for Windows ARM64 needs a cross toolchain we cannot test on real hardware._
~~Shipping the x64 worker under emulation: untested, and a host must be fast.~~

**Load test: simulated participants use mediasoup in the test process with plain RTP over SRTP to the host (synthetic Opus with audio levels and 3-layer VP8 with real key-frame markers), and the real call manager for joining and hand-over. The first host is pinned to 8 logical cores (the plan's minimum host) and its CPU is reported as a share of those 8.**
_The host does the same per-packet work as for WebRTC participants (SRTP, forwarding, layer selection); only ICE and DTLS set-up are skipped. 100 Chromium instances cannot run on one PC._
~~Plain RTP without SRTP (would understate the host's work).~~

**Sealed envelopes:**

- **Sealing:** an own direct-chat event whose recipient is offline is sealed with ECDH P-256 (a one-time key against the recipient's identity key), HKDF-SHA256, and AES-256-GCM. Clear-text routing fields (recipient, expiry) are bound into the key and the tag.
- **Placement:** it is handed to up to 3 online colleagues advertising `envelopes.v1`.
- **Carriers:** each stores at most 50 MB of other people's envelopes (10 MB per depositor), for 7 days.
- **Delivery:** carriers hand them over when they see the recipient's beacon or link; recipients also ask newly linked colleagues (`envelope.fetch`).

_Plan section 8. The one-time key means an envelope does not name its sender; the author's identity and signature are inside, and the recipient checks both. The sender's status reads "Will be delivered when … comes online"._
~~A separate encryption key per user published in the profile (another key to distribute and verify; P-256 keys are safe for both ECDSA and ECDH as used here).~~

**Envelope sizes are bounded (128 KB ciphertext, 16 per frame, 20 frames per tick) and a carrier refuses envelopes for the depositor itself.**
_Rule 17.7: every byte from the network is hostile._

**Other subnets:**

- **Adding:** Settings takes "ip[:port]" addresses. The dial accepts whoever answers there, and TLS pins their key as on first sight.
- **Sharing:** linked peers exchange `peers.exchange` lists: a remote peer gets everyone online, a local peer gets only the remote ones. New remote peers are passed on to the local subnet after 2 s.
- **Keepalive:** remote peers send their own signed beacon over the link every 15 s (and at once on presence change).
- **Retrying:** typed addresses and dropped remote peers are re-dialed every minute.

_Plan section 6. Listed peers are dialed with their userId expected, so a false entry only fails to connect. Measured: one address joins two subnets in about 6 s._
~~Relaying beacons across subnets by multicast forwarding (needs router support).~~

**Profile export:**

- **Contents:** one file holding the PKCS#8 key, a `VACUUM INTO` snapshot of the database, and the user's avatar.
- **Encryption:** PBKDF2-HMAC-SHA256 (600,000 iterations), then AES-256-GCM over the header.
- **Import:** checks the passphrase and that key and database are the same identity. It stages the profile beside the current one, with the key re-sealed by this PC's DPAPI. The swap happens at the next start before the database opens, and the old profile is kept as `<profile>.before-import-<time>`.

_Plan section 5. PBKDF2 and HKDF are standard constructions over SHA-256 (plan section 3); nothing on disk is ever half-replaced._
~~scrypt or Argon2 (not among the plan's primitives).~~

**Updates:**

- **Check:** a daily look at a shared folder for `OfficeMesh-Setup-<version>-<arch>.exe`, newer than this build.
- **Signed build:** accepts only an installer whose Authenticode signer is the same publisher.
- **Unsigned build:** accepts an unsigned installer and says so.
- **Install:** runs with electron-builder's update switches (`--updated /S --force-run`), silent, and restarts the app.
- **Firewall:** the installer checks the firewall rules without elevation first, so an update never asks for an administrator.
- **Newer colleague:** a colleague's `hello` version newer than ours shows "A colleague is running a newer version".

_Plan section 15. Write access to the share is the trust boundary for unsigned builds; offices with a code-signing certificate get a publisher check._
~~A custom update signature key (one more secret for a small office to keep).~~

**Signing: electron-builder signs the installer and app when `CSC_LINK` / `CSC_KEY_PASSWORD` point at the office's code-signing certificate; without them the build is unsigned and the README documents the SmartScreen prompt. The signing path was exercised with a throwaway self-signed certificate.**
_Plan section 15: sign if the office has a certificate._

**Diagnostics and logs:**

- **Log file:** the core writes `logs/officemesh.log` in the profile, rotated at 2 MB with two older generations. It logs ids, counts and errors, never message text.
- **Diagnostics page:** shows versions, addresses, link port, firewall, colleagues (local, remote, linked), envelopes, relay capability, database size and memory.
- **Export:** "Save diagnostics file" writes that plus the log tail to a text file in Downloads.

_Plan section 13 (M6)._

**Soak test: the app with 50 simulated colleagues as full core processes on real TLS and UDP, chatting directly and in a group with the app, changing presence, one quitting and returning every 5 minutes. All the app's processes' memory is sampled every 5 minutes; growth is the last samples minus the first hour after a 30-minute warm-up.**
_The done-when check: no crash, memory growth under 50 MB over 24 hours._

## M6.1: feedback round

**Firewall rules cover every network profile (Domain, Private and Public). The Public-network banner is gone.**
_This is a LAN-only app, and many offices' Wi-Fi is classified Public by Windows. Asking people to reclassify their network just to chat is worse than the exposure, and peers are still authenticated by mutual TLS and signatures. `checkFirewall` now reports a missing rule when an existing rule does not cover the active profile, so old Private-only installs are repaired on the next elevated run._
~~Telling the user to switch the network to Private.~~

**Files stay where they are. Sending hashes the file in place (SHA-256 plus a per-1 MB chunk manifest in `files/manifests`) and serves it from its original path.**

- A sender's file that is deleted, or whose size or modified time changed after sharing, shows "File is missing" on the message card ("It was changed after it was shared" in the details). A changed file would no longer match the hash recipients verify.
- Pasted or snipped pictures are the only things the app stores (`files/pasted`), because they have no original on disk.
- Legacy rows without a stored path fall back to `files/<sha>`.

_The plan calls the app a messenger, not a file store. Copying a multi-gigabyte file on every send doubled the disk use and the send time._
~~Keeping a content-addressed copy of everything sent.~~

**Received files are saved to a folder the user chooses (default `Downloads\OfficeMesh`).**

- A download is written as `<name>.<sha8>.officemesh-part` in that folder and renamed to a unique name when the hash checks out; `Zone.Identifier` is set on the result.
- Resuming a part file works as before (chunk bitmap).
- A received file the user deletes shows "File is missing" with "Download again" while the sender still has it.
- Meeting recordings are saved in `<save folder>\Meeting recordings` and shared from there.

_The user's files belong in places the user knows._
~~A hidden per-profile folder with an "export" step.~~

**Attaching a file only queues it in the composer (preview strip, up to 10 files, 2 GB each). Enter or Send sends the text and the files together; the caption goes with the first file.**
_Matches how messengers work, and lets the user add a message or remove a mistake before anything leaves the PC._
~~Sending on attach.~~

**Incoming images are no longer downloaded automatically.** The card shows the sender's small preview, with a click to save, the same as any other file.
_Auto-download wrote files the user never asked for to the chosen folder._

**Transfer progress on both ends: percentage, speed and time left.**

- The receiver's card shows them while downloading. The sender's card shows one line per recipient ("Sending to Asha, 42%, 18 MB/s, 1 min left").
- Speed is a 4-second sliding window (`Meter`) and the estimate is bytes left over that speed.
- Hashing a large file before it is offered reports progress too (`files.preparing`).
- `file.request` gained an optional `have` field (bytes the requester already has) so the sender can show a real resume position. Older peers ignore it, and a missing one is treated as 0.

_Plan section 8: the wire change is additive in the protocol package._

**The 2 GB per-file limit is unchanged.** Raising it needs the chunk manifest to be paged instead of held whole in a message.

**Sounds are synthesised with Web Audio; no audio files ship.**

- The ringtone is a music-box phrase on a C-major pentatonic scale (4.2 s loop). The ringback heard by the caller is two soft chords (4.4 s loop).
- Short cues: connected, ended, missed, declined, unavailable.
- Output follows the chosen speaker (`setSinkId` on a media-stream destination).

_No licensing question, no extra bytes, and the "no network origins" check stays trivial. The call log `window.officemeshSounds` lets tests assert what played._
~~Bundled MP3s.~~

**Every call ends on a "Call ended / Call missed / Call declined / Call unavailable" screen for 2.6 s, with its sound, before the window closes.** In a full-window call it covers the window; in a small call card it replaces the card. A missed call offers "Call back".
_The user should never wonder whether the other side hung up, did not answer or lost the network._

**Settings is a dialog with a category pane on the left (Profile, General, Calls and devices, Files, Network, Backup and move, Updates, Diagnostics, About).** The old profile dialog is folded into Profile, and "Edit profile" in the status menu opens it.

**Status uses coloured dots (green available, red busy and do-not-disturb with a bar for DND, orange away and be-right-back, grey offline) in the status menu, the people lists, the chat header and invite pickers, from one `PresenceDot` component.**

**Chat and channel content is a centred column at most 960 px wide.** Message lists, typing line and composer share it; the scroll bar and header span the window.

**The calendar follows the Teams layout.**

- Day, work week, week and month views.
- A 30-minute slot grid with working hours (8-17) and weekend shading from the system locale, and a live "now" line.
- Drag over slots, double-click, or right-click ("New meeting", "Go to today") to schedule a meeting at that time.
- A mini month, a filter (all, I organise, waiting for my reply), Meet now, and a New split button.

_Plan section 12: meetings. The layout is a normal calendar pattern; no Microsoft branding or assets are used._

**Each rail shows only its own conversation.** Switching from Chat to Teams used to leave the open chat on screen. Teams shows a channel (or "Pick a channel"), Calls and Activity show an explanatory empty pane, and Files uses the full width.

## M6.2: feedback round

**The app is called InterCom. Names a person sees changed; names that are part of a protocol or a stored format did not.**

- **Changed:** window titles, strings, tray, installer (`InterCom-Setup-<version>-<arch>.exe`, `InterCom.exe`, shortcut), firewall rule names and group, the default save folder (`Downloads\InterCom`), exported file names, the Start Menu shortcut name.
- **Kept:** the package scope `@officemesh/*`, the `officemesh://` page scheme, domain strings inside signatures and ids (`officemesh/envelope/v1`…), the profile file format name, the `.omprofile` extension, the database file name, `appId`.
- **Upgrade:** `appId` is unchanged, so the installer upgrades an OfficeMesh install in place. At start, `%LOCALAPPDATA%\OfficeMesh` is renamed to `InterCom` (if the old app still has it open, the old folder is used where it is). The update check accepts `OfficeMesh-Setup-*` and `InterCom-Setup-*`. `firewall.ps1` removes rules of the old group as well as its own.

_A rename that changed a signed domain string would make every PC's old messages and identity unreadable to the new build and break mixed-version offices._
~~Renaming the wire and storage identifiers too.~~

**Icon: a speech bubble with three dots, drawn by `tools/scripts/gen-icon.mjs` and by `Logo.tsx` from the same shape.** One shape feeds the window, taskbar, tray, installer, toast and title bar.

**Toasts carry the app's name through the Windows user model id.** A packaged build uses its `appId`, which is what the installer's shortcut carries (the old id, `OfficeMesh.Desktop`, matched no shortcut). A development run writes its own Start Menu shortcut, "InterCom (development)", so it is not called "Electron".

**Every call has a window of its own, and an incoming call rings in a small window.**

- **Call window:** one per call, opened by main when the core says a call exists (`HostServices.calls`). It is a renderer of its own that runs that call's media with the unchanged single-call engine; closing it leaves the call. Because it is a separate process, the main window keeps working during a call and shows only a bar ("In a call with…", Show call, Leave).
- **Ring window:** frameless, always on top (screen-saver level, so above full-screen apps), bottom-right of the screen the cursor is on, shown without taking the keyboard. It closes when the call is answered, missed or declined, after saying how for 2.6 s.
- **Roles:** the page's address says which (`?role=call&call=<id>` or `incoming`). The core already served any number of windows and broadcasts events, so no protocol was needed. Only `call.changed` gained an optional `callId` (the call that ended).
- **Instant failures:** a call can end before its window has loaded (Do not disturb, nobody there). The core keeps ended calls for a minute (`calls.ended`) and a new window asks.
- **No system notification for an incoming call.** The ring window is enough. A missed call still leaves a toast and an Activity entry.

_Plan section 9. One renderer per call keeps the engine's module-level state valid and puts media in a process that stays foreground while the user works elsewhere._
~~A call view inside the main window (the old design), a floating mini view.~~

**A second call while in one rings as a waiting call.**

- The core keeps up to three kinds of call: the current one, one waiting, and any number held. A new invitation while busy is a waiting call (one at a time; a third is declined as busy; Do not disturb still wins).
- **Hold and accept:** the current call is parked and the user is flagged on hold (the same `onHold` the Hold button used). Its window stays open and its media connections stay up, muted; the others see "On hold". **Resume** takes it back and puts the other on hold.
- **End and accept:** hangs up the current call.
- **Add to current call:** the waiting call is declined and its caller invited into the current one (`call.decline` then `call.invite`, both existing messages, so older builds behave too: the caller sees the decline, then a call from this PC).
- **Relayed meetings cannot be put on hold** (the relay's notifications are routed for the current call only). Add, end and decline are still offered.
- Waiting calls ring with two soft pings, not the ringtone, so the first call is still audible.

_No wire change. One slot more in the manager, not a second manager._
~~Auto-decline as busy (the old behaviour) and a full multi-call session model.~~

**Remote control of a shared screen.**

- **Request, grant, deny and revoke** are messages on a new negotiated data channel of the call (`control`, id 2), peer to peer. It is DTLS-protected and tied to the signed session description, so a message comes from the person it names. A peer without it never opens it, so mixed versions work. It does not work in relayed meetings (no direct links).
- **Whole screens only.** The sharer must be sharing a screen, because input is mapped onto that display. A window share answers "only a whole screen".
- **Consent is explicit and revocable:** the sharer's call window is raised and flashed, shows Allow or Deny, and expires in 30 s. While allowed, the share border turns orange and the sharer can stop it at any time; stopping the share, the call, or losing the connection ends it.
- **Injection** is done by a PowerShell process calling `SendInput` (Electron cannot inject input), started when control is granted and ended when it stops, with scan codes so keyboard layouts are not an issue.
- **Main re-checks everything:** only a call window may send, only while granted, only for a whole screen being shared; positions are mapped onto that screen; events are rate limited; nothing is delivered into InterCom's own windows (the sharer keeps the controls to stop it); keys are dropped while a window of this app has focus; held keys and buttons are released when control ends.
- **Not possible:** controlling elevated windows (Windows blocks it), the secure desktop, Ctrl+Alt+Del.

_Teams has the same shape (request, allow, stop). Input stays on the LAN, with no helper installed._
~~A signed native helper or a bundled input library (no compiler on the build machines, and one more binary to trust).~~

**Call canvas follows the app theme, and the controls cannot be covered.** Tiles in the gallery fill their grid cell (rows are `minmax(0, 1fr)`), the body clips its content and the control bar is `flex: none` above it. Before, 16:9 tiles grew past the window when it was maximised and painted over the controls.

**Reactions sit under the bubble, outside it,** with a hover card ("1 reaction", names), as Teams does.

**Main window, from the Teams screenshots.** Chat list: filter chips (Unread, Chats, Groups), Favorites and Chats sections that fold, a "..." button and right-click menu per chat (favorite, mark as unread, mute, hide). Chat header: Chat and Shared (files) tabs. Back and forward arrows beside the logo. Favorites, hidden chats and marked-unread are personal to this PC and live in the page's local storage; hiding is undone by new activity.

_Done from the screenshots as inspiration; no Microsoft names or artwork. Not done: "Open in new window", "Move to section", "Remove chat history", Storyline, Recap and Notes tabs, workflows._

## M6.3: feedback round

**The taskbar and toast identity come from a Start Menu shortcut, so development runs get one too.** Windows names a toast, and draws the taskbar button, from the shortcut that carries the app's user model id. The installer's shortcut does it for an installed build. A run from source (including the tests and the soak, which pass `--data-root`) wrote none, so it was "Electron" with the Electron icon. Every unpackaged run now writes `Start Menu\Programs\InterCom.lnk` with id `InterCom.Desktop` and the icon, unless a shortcut of that name already exists with another id (an installed InterCom's), which is never touched. Windows are given the multi-size `.ico` rather than the 512 px PNG.

_A toast has no field for an app name: the shortcut is the only way._
~~Putting the name in the toast title (it would repeat on every message).~~

**Dark mode is a setting: Same as Windows (default), Light, Dark.** It is stored with the other settings (`theme`), and the core tells the host, which sets `nativeTheme.themeSource`. Every window follows through `prefers-color-scheme`, and main re-colours the title-bar buttons of the main and call windows. The app already followed Windows; this lets someone choose without changing Windows. The window background is nearly opaque, so dark looks dark even where Mica does not show through.

_One switch in one place covers every window, including call windows opened later._
~~A per-window theme in the page's local storage.~~

**Delete chat removes a chat's history from this PC only.** Right-click or "..." on a chat, then Delete chat, then a confirmation.

- **What goes:** the messages and what hangs off them (reactions, pins, polls, receipts, activity entries, saved marks), and the chat leaves the list. Files already saved stay in the user's folder.
- **How it stays deleted:** migration 10 records, per conversation, the newest message time held at that moment (`conv_clear`). Nothing at or below it is materialised again, even when the signed log is replayed. The log itself is kept so sync does not re-send it.
- **What the others see:** nothing. They keep their copy. A new message from them brings the chat back with only the new messages. Direct chats and group chats can be deleted (a group stays joined: Leave is separate); channels cannot.

_The history is signed and shared; the only honest delete is "not on this PC". Teams' "Remove chat history" does the same._
~~Deleting for everyone (cannot be enforced on other PCs), or deleting the log (sync would fetch it back).~~

**A paragraph is a block.** Fluent's `Text` is `display: inline` even as a `<p>`, so side padding showed only on a wrapped paragraph's first line (the Teams empty-state text). One CSS rule makes `p.fui-Text` a block, for eight existing places and future ones.

**Chat headers are one height**, with the Chat and Shared tabs right after the name in every chat; groups show a square avatar like the list; meeting cards in a chat share one width.

## M6.4: feedback round

**The profile card is about the person; the safety phrase is one click away.** The card shows name, job title, presence, status message, when this PC first saw them and the address they were last reached at. "Verify identity" opens the safety phrase and the Mark as verified button.

- **Why it stays at all:** with no server and no sign-in, comparing six words in person is the only way to tell a colleague from someone who picked the same name. It is a check made once, not information about the person, so it no longer takes the card's space.
- **When it opens by itself:** for a person flagged "new device or unverified", next to the warning, because the warning tells the user to check it.
- **Where one's own phrase is:** Settings > Profile (the card's help text says so).

~~Removing the safety phrase.~~

**Colleagues can be taken off the people list.** Right-click an offline colleague (or the "..." button) > Remove from list, or Remove all offline colleagues. It is a flag (`peers.hidden`, migration 11), not a delete: their chats, names in old messages and pinned key stay, and the flag clears the moment they are seen online again. Someone online cannot be removed. The list also leaves out, without being asked, offline people whose name was never learned (a beacon heard once, so there is nobody to talk to) and offline people last seen over 30 days ago with no chat.

_Deleting the row would orphan chats and break the key pin (trust on first use)._
~~Forgetting the key.~~

**Why a test PC's colleagues appeared in a real profile.** They were simulated colleagues (`tools/sim`) from developer test runs. The simulator beaconed on the real network by default, and an installed app on the same PC heard five of them twice, for about a second each; every colleague seen is remembered. The simulator now defaults to this PC only (`--lan=loopback`); `--lan=all` is an explicit choice and prints a warning. The app itself invents no colleagues.

**Paragraph text with padding is a block** (the offline note under a chat was an inline span, so its first line was indented): the two such places in chat and one in the people picker were found by scanning every `Text` that carries a spacing class.

## M6.6: feedback round

**Files arrive by themselves; "Receive files automatically" (on by default) turns that off.** The sender presses Send and the file is delivered: the receiving PC starts the download when the message arrives and saves it to the chosen folder. Only messages that arrive while the app is running count (a file message newer than 10 minutes); history that syncs in later is never fetched by itself. With the setting off, each file shows a Download button as before. A download first checks the drive has room for it (plus 256 MB) and says so at once if not.

_This is a LAN messenger; a click to receive was friction, not safety. The owner asked for it; the risk is that any colleague can put a large file on your disk, which the free-space check and the visible Cancel limit._
~~Auto-receive only for small files or pictures.~~

**There is no practical file size limit: 4 TB instead of 2 GB.**

- **Why 2 GB:** the chunk list (32 bytes per 1 MB chunk) had to fit in one message, and the chunk index in the wire schema stopped at 2047.
- **What changed:** the chunk list is fetched a page at a time (`file.manifest` gained an optional `from`; a page is 2048 hashes; a file up to 2 GB is one page, so older peers still answer correctly). The limit in the offer, the chunk index range and the chunk bitmap schema were raised to 4 TB (4 million chunks; the list is 128 MB in memory on each side). A downloader's bitmap of held chunks is written to the database about once a second, not with every chunk (it is 512 KB for the largest file). A partial file whose bitmap would not fit a frame is served only when complete.
- **Compatibility:** a PC running 0.7.x or older cannot read an offer above 2 GB, so every PC should be on 0.8.0 before files that large are shared.
- **Verified:** a 2.1 GB file (more chunks than one page) transfers and arrives intact in the integration tests; the 1 GB resume test still passes. Files beyond that were not tried.

**Noise suppression: three levels, High by default.** Off sends everything. Standard is the browser's own (steady noise, echo, automatic gain). High also turns automatic gain off (it is what raises far-away sound to a voice's level), adds a 100 Hz high-pass filter, and a gate that tracks the room's level and the user's own voice and lowers anything well below the voice by about 24 dB, with a 300 ms hold so words are not clipped. It is done in the page with Web Audio (no model or library to ship), so it removes a colleague across the room, keyboards and fans but cannot separate two voices at the same distance; a trained model (RNNoise) would do better and is the next step if this is not enough. Set in Settings > Calls or from the microphone's menu in a call.

**Screen sharing at LAN quality.** Capture is the screen's own size (up to 4K) at up to 30 frames a second, with the sender allowed 25 Mbit/s (8 Mbit/s through a meeting relay), never scaled down, and told to drop frames before sharpness. It was 1080p at 15 frames a second with the browser's default bitrate, which starts low and drops resolution when the link looks busy.

**Remote control, rebuilt.**

- **Why it failed in use:** the safety rule that refuses to click InterCom's own windows compared the pointer with the windows' bounds, not with what is on top. A call window maximised behind the shared application made every click land "inside" it and be thrown away silently. The tests passed because their call window was small.
- **Now:** a small compiled helper (`rcinput.exe`, built from `resources/rcinput.cs` with the C# compiler that ships with Windows, so nothing is installed) asks Windows which window is really under the pointer (`WindowFromPoint`) and drops input only when it is InterCom's own, on top. It also avoids PowerShell (blocked by some policies and slow to start).
- **A shared window can be controlled too** (it is brought to the front on a click), not only a whole screen.
- **It never fails silently:** the sharer's side starts the helper before saying yes; if it cannot, the request is answered "not available on this PC" with the reason, and a helper that dies or a shared window that closes ends control with a message.
- **Teams-style flow:** a Take control button in the call bar, a "Request control?" confirmation, and a "Presenter mode: X is requesting control" card with Deny and Give control for the sharer.
- **Pointers you can tell apart:** the controller's own pointer is drawn with their avatar; the shared pointer (where the real pointer is on the shared screen) is drawn with the avatar of whoever has a hand on it, the controller while their input is arriving, the sharer otherwise. Everyone in the call sees it.

_There is one real pointer on the sharer's PC, so the two people take turns moving it; the avatar shows whose turn it is._

**Call controls along the top, like the Teams reference.** Chat, People, Raise hand, React, View, Whiteboard and More, then Camera and Microphone (each with a chevron for devices and options), Share and a red Leave. The timer and who is in the call sit at the left. A People panel lists everyone with muted, hand, sharing and hold marks.

**Side panes resize.** The list pane in the main window and the chat or people panel in the call window have a drag handle (also arrow keys; double-click resets) and remember their width on this PC.

**The gallery fits.** Each tile used to be `height: 100%` of the whole grid, so with two rows the second ran off the window; tiles now fill their own grid cell. Tiles beside a shared screen shrink to the height they are given.

**The "Drop files" cover cannot be left behind.** A cancelled drag (Escape, leaving the window, ending elsewhere) fires no event on the pane, so the cover also goes away when the browser stops reporting the drag (about 0.8 s), and on any drag end, drop, key press or loss of focus.

**The chat's formatting buttons wrap** in a narrow pane (the meeting chat) instead of running past it.

**Soak test: not performed.** The owner decided on 2026-10-06 that no 24-hour soak is needed. The only runs were about 90 minutes (healthy: 50 colleagues online, 331 MB) and shorter, so the M6 done-when ("no crash, under 50 MB growth over 24 hours") was not demonstrated.

## M6.7: feedback round

**The chat is a 910 px column, laid out as in the Teams reference.** The bubbles and the composer share the same 910 px (centred in the pane); the senders' pictures hang in the free space to the left of the bubbles instead of taking room from them. In a narrow window the column shrinks and keeps 48 px each side for the pictures. Channels keep their own, wider layout.

**Who and when sit over the bubble, not in it.** A message's first line of a run is "Name time" (just the time on your own, right-aligned), small and grey, outside the bubble; "Edited" joins that line. A line between days says Today, Yesterday, the weekday for the last six days, then "Tuesday, September 29" (with the year for another year). The time is "10:09 AM" today, "Wednesday 4:11 PM" within the week and "9/29 12:08 PM" before that, in the PC's own date and time format. These thresholds were read from the reference screenshots (weekday labels for the last six days, dates beyond); they are in one place (`format.ts`) and unit-tested.

**The reaction bar belongs to the bubble.** It showed when the pointer was anywhere on the message's row, which is as wide as the pane, so it popped up beside short messages. It now shows only while the pointer is over the bubble (or the keyboard is in it, or its More menu is open), and is not clickable while hidden.

**Files show what is in them.** A completed file of a common kind shows a card in the bubble like the Teams reference: its icon, name and size (and page count), Forward and More buttons, and under them the first page, lines or cells, with an open button. Clicking opens the built-in viewer. Pictures and videos still show themselves inline (a picture now opens in the viewer too); a file that is not a kind the viewer knows keeps the plain card.

| Kind                             | Bubble               | Viewer                                                                    |
| -------------------------------- | -------------------- | ------------------------------------------------------------------------- |
| PDF                              | first page           | all pages, zoom, fit, page number, search with highlight, selectable text |
| Pictures                         | the picture          | zoom, fit                                                                 |
| Word (.docx)                     | first lines          | headings, bold and italic, lists, tables, pictures                        |
| Excel (.xlsx)                    | first cells          | every sheet, dates and number formats applied, row and column labels      |
| PowerPoint (.pptx)               | first slide's text   | every slide's text                                                        |
| CSV, TSV                         | first cells          | a grid                                                                    |
| Text, code, JSON, logs, markdown | first lines          | the text (first 2 MB)                                                     |
| Audio, video                     | player in the bubble | player                                                                    |

- **Previews are made from the file, locally, when the card is on screen**: a PDF is read in byte ranges (a big PDF shows page one at once); Office files up to 12 MB are opened for the bubble, 40 to 60 MB for the viewer, one at a time. Results are remembered while the app runs.
- **pdf.js for PDFs** (Apache-2.0, bundled with its fonts and character maps, no network). It draws a page on a canvas, which the bubble thumbnail also needs, and gives the page's text for selection and search. Not tried: Chromium's built-in PDF viewer (an embedded page the app cannot lay out or search itself, and it would not give a thumbnail).
- **Office files are read by our own small readers** (`fflate` to unzip, then the XML) instead of a converter library or an online viewer. Everything is built as DOM nodes with `textContent`, so nothing in a file is ever parsed as HTML and there is no sanitiser to get wrong; links are drawn, not followed. Not used: mammoth (its output is HTML, which would need sanitising) and SheetJS (to my knowledge its npm release is an old one with published security issues; not re-checked here), and Office Online (needs the internet).
- **Honest limits.** The viewer is a preview, not Office: Word shows structure, not exact page layout, headers or footnotes; Excel shows values, not formulas, charts or merged cells; PowerPoint shows each slide's text, not its layout or pictures (the note says so). The old binary formats (.doc, .xls, .ppt) are not read; they open in the PC's own program.
- **The file protocol serves any completed file's bytes now**, not only pictures and video, because the viewer reads them. The core still answers only for a complete file of exactly the type asked for; anything that is not plain audio, video or a picture is sent as opaque bytes (`application/octet-stream`), and every answer carries `default-src 'none'; sandbox`, so even a file opened as a page could run nothing.
- **Origin check.** pdf.js's code has strings that look like URLs (XML namespace names for forms and metadata, a licence link, two base hosts for the URL parser, a `http://` prefix for `www.` links). Each is allowed by name with its reason in `check-origins.mjs`; none is ever fetched, the session blocks http(s) anyway, and anything else new still fails the build.
- **The viewer opens in the main window only**, covering the list and the pane (the rail and title bar stay) like Teams; going to another area closes it. In a call window a file opens in the PC's own program.

### M6.7 follow-up: a sent file appears in the chat at once

- **Decision.** Pressing Send takes the files out of the composer and puts each one in the chat as a message of its own, with "Preparing the file · 49%", then the real message replaces it. A file that cannot be read stays there as "Not sent" with Try again and Remove. The composer is free to use meanwhile.
- **Reason.** The message has to carry the file's SHA-256 and chunk hashes, so the core must read the whole file before it can make the message. That is minutes for a 6 GB file. Showing the wait as a progress bar in the composer, then a second, different bar in the chat, looked like the file was sent twice.
- **How.** The bubble is only what this window shows (`chat/outbox.ts`): no message exists, nothing is stored, nothing goes on the wire, so older PCs are unaffected. Files from one composer go one at a time, in order. It shows in the chat, a channel's posts and thread, and the meeting chat.
- **Rejected.** A real message with a "preparing" state in the log (needs a wire change, and a message that may never be completed would reach other people). Hashing while the file is only attached (it would read files the person might remove, and the work could be wasted). Keeping the composer locked until done (blocks typing for minutes).
- **Limit.** Hashing cannot be cancelled once it starts, so there is no Cancel button on a preparing file.

## M6.8: files go at once, file card, Shared table, duplicate banner reply

### Files are not fingerprinted before they are sent

- **Decision.** Sharing a file from disk reads nothing: the file's id is a random 256-bit value, the `manifest` is `UNHASHED_MANIFEST` (64 zeros), and the message is sent as soon as the file's size is known. The receiver fetches it from the sender and checks the size when it ends. A 6 GB file is on its way in under a second (it took minutes before). Pasted and snipped pictures (under 25 MB, saved by the app) are still fingerprinted: they are small and keep the chunk check.
- **Reason.** The fingerprint's job was to let any holder serve a file and let the receiver verify every chunk from any of them. On a LAN, with one sender, that buys little: the link is TLS, so bytes cannot change in transit, and the cost was reading the whole file once before the first byte went out (and a second time on the receiver after the last). The user chose speed over resume and multi-source.
- **What is lost.** Content de-duplication (the same file sent twice is two files). Detecting a file that was damaged on a disk or edited in the middle of a transfer: a changed original is still not served (size and modified time are checked for each chunk), but a flipped bit on a disk is not found. Fetching from a colleague who already has it: such a file comes from its sender only (people who forwarded it count as senders), so a third PC cannot hand out different bytes under someone else's message. Resuming still works inside one session and across a restart (the chunk bitmap is kept), but only from the same unchanged original.
- **Compatibility.** The message still parses on older builds, but they look for a chunk list that does not exist, so a file from 0.10.0 shows as unavailable on 0.9.x and older. Everyone should update. Files from older builds are received by this build as before (with the chunk check).
- **Rejected.** Hashing while sending (the message cannot carry a hash that is not known yet; it would need a second message and a protocol change older builds cannot read). Hashing only small files (two ways to do one thing, and the user asked for no waiting at all). A hash per chunk sent with the chunk (a new frame format; older builds could not read it).

### A file sent to someone who is away is kept and goes the moment they are back

- **Decision.** A file offer is delivered like any message (it waits, or is carried sealed, until the person is online). When it reaches them it is fetched at once, however old it is, if it was sent since this PC last ran (`app.lastRunAt`, written every 30 seconds and at close, with 5 minutes of slack for clocks that disagree), or in the last 10 minutes. A download that is waiting for its sender is remembered in the database (`files.wanted`, migration 12) and started again after a restart. History from before this PC took part is still never fetched by itself. The sender's card says "Waiting for X to come online" until then.
- **Reason.** Before, a file that reached a PC more than 10 minutes after it was sent counted as history and needed a click, and a download waiting for its sender was forgotten when the app closed.
- **Rejected.** Fetching every file that syncs in (a new PC joining a group would pull its whole history). Queueing the bytes on a third PC (the file is read from the sender's disk, not copied anywhere: that is the design).

### A reply typed into a notification is one message

- **Decision.** The core ignores the same words to the same chat from a notification within 5 seconds, and each notification passes on its reply once.
- **Reason.** On Windows the reply event can arrive more than once for one typed reply. This could not be tried with a real Windows notification here, so the fix is at the one place every reply passes through.
- **Rejected.** Dropping repeats of any message (people do send "ok" twice on purpose, from the composer: only notification replies are filtered).

### Other

- **File card.** Open and Show in folder are under the name, size and progress, not at the right.
- **Shared table.** Columns have widths and every cell clips its text with an ellipsis (the full name is the tooltip), so a long file name never runs into the next column. The chat header's name and "New device" badge stay on one line and shorten, the badge first.

## M6.9: one chat in the call window, a temporary group for calls past two people, End for everyone

### The call window shows the main chat

- **Decision.** The chat beside a call is `ChatPane` (new, `chat/ChatPane.tsx`), the same component the main window draws: bubbles, day lines, delivery status, typing and offline lines, pending files, the composer and the file drop. The call window only asks for `compact` (a narrower column). `MeetingChat` is now a title and a `ChatPane`; the channel-post look (`MessageItem variant="post"`) stays for channels.
- **Reason.** The call window had its own small copy of the chat that lacked half of what the main chat does and would fall behind with every change. One component means every improvement shows in both.
- **Rejected.** Keeping `MeetingChat` and adding features to it one by one (two chats to keep equal).

### A call that grows past two people gets a temporary group chat

- **Decision.** At three people in a call that did not start in a group chat (or in a meeting), the organiser's PC makes an ordinary group of everyone in the call and tells the others its id in `call.state` (`chat`, also in the invite). The call window then shows that group instead of the one-to-one chat. It is kept out of the chat list, the unread badge, toasts and the calendar's places while the call goes on (`call_chats`, migration 13; `ConversationView.temporary`). Whoever joins later is added by the organiser; whoever leaves stays a member. When a PC's call ends, a chat anybody wrote in joins the list there with its whole history and files; one nobody wrote in is never shown. A message that reaches a chat already discarded brings it back (nobody loses a last-second message). A call of two started without a chat opens the direct chat with the other person, so there is always one.
- **Reason.** The old chat id stayed the one-to-one chat for the whole call: a third person was not a member of it and could not take part. The spec asks for the chat to be a conversation with another lifecycle, not another chat.
- **Honest limit.** The group's creation is a signed event that cannot be taken back, so an unused call chat stays as an invisible record in the logs of the people who were in the call. Nothing about it reaches anyone who was not.
- **Rejected.** A conversation that exists only in the call window and becomes real on the first message (every send, share, poll and reaction would have to understand an id that is not a conversation yet). Making the group only when the call ends (the messages would have no home meanwhile, which is a second chat). Every participant making it (two ids).

### Leave and End for everyone

- **Decision.** "Leave" already took out only the person who leaves; it stays the main button. The organiser of a call of three or more also has "End call for everyone" in a menu on the Leave button, behind a confirmation: `call.control` with the new action `end` (also over the relay host for large meetings), after which every PC stops its media, sharing and remote control and closes its window through the normal "Call ended" path, which also settles the call chat. When the organiser leaves a mesh call, the person who has been in longest (ties by user id) becomes the organiser on every PC, with no message. A request from anyone else is ignored.
- **Reason.** Nobody could end a call for everyone, and a call whose organiser had left had nobody with organiser controls.
- **Compatibility.** Older builds ignore the new `end` control (and the `chat` field), so on one of them the call goes on until the organiser's hang-up reaches it, and its chat panel shows nothing for the group. Large relay meetings keep their host hand-over and have no organiser hand-over.
- **Rejected.** Letting any participant end it (the spec says never). One "End" button for everyone (people would end calls by mistake; Leave is the common action).

## M6.10: feedback round (calls, noise, file speed, updates, lists)

### A fast LAN no longer bans itself: file transfer speed

- **Decision.** Measured first: 768 MB between two PCs on one machine took 65 s (12 MB/s), because the transfer ran at about 280 MB/s for two seconds and then the receiving side closed the link for "too many frames" and refused it for 60 s (`ABUSE_BAN_MS`). Every request for chunks is a text frame and the limit is 50 a second. Now: chunk requests are counted apart (`LINK_LIMITS.fileRequestsPerSecond`, 400, recognised by how the envelope starts, so nothing is parsed before the check), downloads ask in whole lots of 16 chunks instead of a trickle of small requests, the sender keeps a read handle per file (closed after 3 s idle) instead of opening and closing the file for every megabyte, reads 4 chunks ahead of the one it is sending, and the link no longer copies each megabyte twice on arrival. Result on loopback with real TLS: 358 to 618 MB/s (2 GB and 768 MB).
- **Reason.** The slowdown was not the network or the disk; it was our own abuse rule tripping on legitimate traffic, and the stall it caused looked like a slow transfer.
- **Rejected.** Raising the general text-frame limit (it protects against flooding by anything). Bigger chunks (a protocol change older builds cannot read). Several connections per transfer (one TLS link already moves more than a 1 Gbit/s LAN carries).
- **Honest limit.** The measure is on one PC. A real 1 Gbit/s link is about 110 MB/s, and a slow disk or an antivirus scanning the file will still decide the speed there. Older builds keep the old limit of 50 a second, so a transfer to a PC that has not been updated can still trip it.

### Calls: nobody is dropped for a hiccup

- **Decision.** A participant was dropped (removed from the call for everybody, and their own call ended) after 6 s without a heartbeat, 20 s without connecting, or at once when the connection reported `failed`. Now `calls/liveness.ts` decides: anything arriving counts as hearing from them (heartbeat, whiteboard and control messages, and sound or picture bytes, probed through `getStats`); a window that was itself stalled for 3 s or more forgives the silence; a quiet or failed link gets its connection restarted (`restartIce`, at most every 4 s) before anything else; a connected link is dropped after 7 s with nothing at all (still inside the 10 s the "cable pulled" test requires), a `failed` one after 15 s, one that never connects after 45 s (restarted from 15 s). A link that arrives before the roster that lists its sender (a third person joining) is kept for 20 s instead of being dropped as a stranger and never rebuilt, and a missing link is made again on the next tick.
- **Reason.** The likely causes of random removals in group calls: the offer-before-roster race when someone joins (the link was dropped, the later joiner then waited 20 s and dropped the other person), a whiteboard picture holding up the heartbeat behind it, and a busy window.
- **Not reproduced.** This could not be shown on real PCs here. The cause is argued from the code, and the decision is covered by unit tests of `judgeLink` only.
- **Rejected.** Never dropping (a dead PC would stay in the call). A longer fixed timeout alone (the race would remain).

### Noise: a new setting is applied, and the gate is stricter

- **Decision (setting).** Changing the level opened the new microphone before letting go of the old one. Chromium shares one capture per device and fixes echo cancellation, noise suppression and gain when it is first opened, so the new level did not take effect until the microphone had been released (which "off" and back did). The old microphone is now stopped first; the processing the browser reports is compared with what was asked and applied again if it differs; and the engine reopens the microphone whenever the setting changes in any window (it only did so from the call window's own menu).
- **Decision (gate, "High").** The gate shuts about 40 dB down (was 24). It opens only for sound that is at least half the user's usual voice level and not click-like (key presses and clicks are short broadband bursts), for 3 blocks in a row, with 43 ms of look-ahead so the first syllable is not lost. It stays open only while the sound is above about a third of the usual level, so a colleague talking after the user does not keep it open. One shout cannot raise the level it learns, and the level tracks down again.
- **Honest limit.** This is signal processing tuned on synthetic cases (unit tests of the gate); it was not listened to on real microphones in a real office. A neural suppressor (RNNoise) would do better still, but it is a new dependency and a WebAssembly file in the app, so it was not added without being asked.
- **Rejected.** Cutting to total silence while the user is quiet (a hard gate sounds dead). An audio worklet rewrite (the script processor works in this Chromium).

### Updates: the office's folder, and installing is required

- **Decision.** An installed build looks in `the office’s update share` unless Settings names another folder (an empty box means the office's folder, so updates cannot be switched off by clearing it). It is looked at every 10 minutes (was daily). When a newer installer is found, the main window shows a dialog that cannot be closed and has one button, "Install and restart". A call in progress is never cut off: the dialog waits until it ends, and the banner shows meanwhile. Dev and test runs have no default folder.
- **Reason.** The request: a default location and a forced update.
- **Not verified.** The share was not reachable from here, so only local folders were tried (an e2e that finds a newer installer; a test of the default and the fallback). Installers from the share run as whoever uses the PC; this build is not code-signed, so the check says only "unsigned".

### Other

- **Join from the chat.** A call made from a group chat now leaves the same card as "Meet now" ("Meeting started", Join), and the group chat's header has a "Join call" button while one is going on, so a member who missed or declined the ring can join. The card is marked ended when the last person leaves. Calls of two leave no card, and no banner or toast is raised for the card of a call the PC is already ringing for.
- **Hands, People pane.** The hand button shows how many hands are up, and so does the People pane. The People pane has an "Add people" button and lists those being rung as "Calling…" (the dialog is the one the More menu uses).
- **Banners.** Recording, hold, reconnecting, hosting, sharing and remote control are chips in one row under the control bar that is gone when there is nothing to say (each was a full-width bar).
- **Lists.** One rule for who is offered in every list of people (chat list, new group, add to call, mentions, forward, search): somebody removed from the side pane, never named, or unseen for 30 days with no chat is not offered. The old dummy colleagues were only hidden in the side pane.
- **Calendar and whiteboard.** The calendar opens on Week. The whiteboard's text and note pop-ups say "Add text" and "Add note" (they said "Add people").

## M6.11: feedback round (People rail, In a call, status in the control bar, group pictures, forwarding, scroll bars, updates)

### "In a call", not "Busy"

- **Decision.** The discovery beacon gains an optional `inCall` flag (the signature covers the raw record, so builds that do not know the field still verify the beacon and read `presence: busy` as before). Colleagues who see the flag show "In a call" in the chat title, the people list, the profile card and the status menu; the dot stays the Busy dot.
- **Reason.** Showing Busy for a call looked like the person had chosen it. A new `presence` value would have made older builds drop the beacon (their schema is a closed list), so the flag is separate.
- **Rejected.** A new `inCall` presence state (older builds would see nobody who is in a call).

### People have their own rail

- **Decision.** The People rail (after Chat) lists everyone found on the network, online first, with the same removal menu and the same rule for who is listed as every other list. The chat list is only chats; picking someone opens (and from then on lists) the chat. Test ids are unchanged; the e2e helpers `clickPerson` and `expectPerson` go to the rail and come back.
- **Rejected.** A second copy of the list kept hidden in the Chat rail so the old tests need no change (a hidden duplicate of the list in the page is not something to keep for the tests' sake).

### The call's feedback is in the control bar

- **Decision.** Recording, hold, reconnecting, hosting, sharing and remote control are chips at the left of the control bar (which has room), shortened with an ellipsis, with the Stop and Resume buttons kept. The request to take control stays a card over the call because it has to be answered. The picture below does not move when a chip appears (e2e measures the bar and the first tile).
- **Reason.** The last version used a row of its own under the bar, which still took space from a shared screen.

### Noise "High" runs on the audio thread

- **Decision.** The gate was a script processor, which runs on the page's main thread: a busy moment (video tiles, a whiteboard, recording) made the audio stutter, and a gap in the sound that goes out is heard as crackle. It is now an audio worklet (`gate.worklet.ts`, built to `gate-worklet.js` beside the page), with the same decisions per block and the gain smoothed per sample (open in 3 ms, close over 80 ms) so it never steps from one level to another. If the worklet cannot start, the browser's own suppression still applies and the call goes on.
- **Not shown.** This could not be listened to here. A test hook (`window.officemeshGate`) shows in the e2e that the worklet loads and runs.

### A group can have a picture

- **Decision.** `conv.rename` now carries an optional `picture` (a 128 x 128 JPEG made on the user's PC, at most 40,000 characters of base64) and its `title` is optional. Any member can set it, empty removes it, and a rename keeps it. It travels in every member's copy of the group's log, like the name. It is stored with the group's derived data and sent to the window in `ConversationView.picture`.
- **Compatibility.** A build that predates it needs `title`, so it stores a picture-only event without applying it (the same way it treats any invalid body): no harm, no picture.
- **Rejected.** A separate fetch of the picture (a second path to keep in step; the image is a few KB). A new event type (older builds would see an unknown type).

### Forwarding

- **Decision.** A dialog of its own (`ForwardDialog`): a preview of the message, a search, the chats (groups with their pictures, people with their dots) and then the other people, several can be ticked, an optional note that follows the message, and one button saying how many it goes to. A person with no chat yet gets one.

### Scroll bars and button text in dark mode

- **Decision.** `color-scheme: light dark` makes the native parts follow the app's theme; the scroll bars are thin, grey and invisible until the pointer is over what scrolls. A plain `<button>` takes its colour from the page (it was black on dark: the reaction counts).

### A deleted message keeps nothing it was sent with

- **Decision.** The core no longer reports urgent, mention, quote or pin for a deleted message, and the bubble does not draw them.

### Updates: the default, the force, and the SmartScreen warning

- **Default folder.** Unchanged from 0.12.0 (the installed build looks in `the office’s update share` unless Settings names another folder). It is in the installed build, not in the installer, so first install and update are alike. If a PC cannot read the share (the account has no access), the check says so in Settings > Updates; nothing blocks.
- **Forced.** The "Update required" window now also starts the installer by itself after 2 minutes, with a countdown, if nobody answers. A call in progress is never cut off (the window waits for its end).
- **The warning.** "Windows protected your PC" is Microsoft Defender SmartScreen reacting to an installer that has no code-signing certificate, and to the "from another computer" mark that a download or a copy adds to it. It cannot be removed from the installer without a certificate the office buys or an internal one that every PC trusts. What was done: the in-app update runs the installer from a copy in the temp folder with that mark removed (so updates do not show it), and the release folder carries `Install-InterCom.cmd`, which removes the mark from the installer beside it and starts it, for a first install. Done by hand, the choice in the window is More info, then Run anyway.
- **Rejected.** Disabling SmartScreen or changing a PC's security settings (not ours to do). A self-signed certificate (every PC would have to trust it first; the warning stays until then).

## M6.12: a public release, with updates from GitHub

### Updates from a GitHub release

- **Decision.** Installed builds ask the GitHub API for the repository's latest release (about every 6 hours, 30 minutes after a failure; the API allows 60 requests an hour from one address, and an office shares one). A newer, published (not draft, not pre-release) release with `InterCom-Setup-<version>-<arch>.exe` for this PC's architecture is offered as a banner with "Install and restart". The installer is downloaded to the temp folder, its length and SHA-256 are checked as it arrives against the digest GitHub publishes for the file (or `SHA256SUMS.txt` in the release), a signed build also requires the same publisher, and only then it is run (the host copies it and removes the "from another computer" mark first, as for the folder). A release with no checksum is not offered. Only GitHub's hosts are followed (redirects are handled by hand); anything else stops the download.
- **Order.** The office's own shared folder, if one is set, is checked first and its update is required (the unclosable window, as before); GitHub is asked when the folder has nothing newer. A GitHub update is a banner, not a block, unless the release notes contain `intercom:required`.
- **Privacy.** It is the only request the app makes to the internet. It carries the address of the PC, and `InterCom/<version>` as the name. It is a setting (Settings > Updates, on by default) and the check says nothing when there is no internet. Where it happens: the core process, not the pages (their session still blocks every http(s) request); `check:origins` allows exactly this one address, with its reason.
- **Rejected.** Downloading and running whatever is attached to the latest release without a checksum (a changed file could not be noticed). Making every update required (a public app that stops until it is updated would be hostile; an office that wants it uses the folder or the marker). A background download and silent install (the user chooses when the app restarts). Asking for a token (the project is public).
- **Not shown.** It was tried against a fake GitHub (tests: release choice, checksum and size, redirects, publisher, order with the folder), not against github.com: there is no public release yet. The first real check happens when the first release is published.

### Nothing personal in the source

- **Decision.** The public source holds no office address: the shared folder that 0.12.0 and 0.13.0 had built in is now an optional build setting (`INTERCOM_OFFICE_UPDATE_FOLDER`), empty in the public release; the address was taken out of the documents. A colleague's file name copied from a screenshot into a test was replaced by an invented one. Searches of the whole tree (tracked and untracked files) and of the history for e-mail addresses, user and PC names, private addresses and shares, keys, tokens and certificates found nothing else. The history carries the author's name and e-mail address on each commit; that is a decision for the owner before publishing (see the release notes of this change).
- **Note.** 0.12.0 and 0.13.0 installers contain the office's address and are not published; the public release is a new version.
