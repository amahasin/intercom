# InterCom

Workplace chat, calls and meetings for an office LAN, with no server. Every Windows 11 PC
running InterCom is an equal peer: colleagues find each other automatically, and nothing
ever leaves the local network.

InterCom was called OfficeMesh before. Its data folder (`%LOCALAPPDATA%\OfficeMesh`) is
moved to `%LOCALAPPDATA%\InterCom` the first time the new build starts, and installing it over the
old one upgrades in place.

**Status:** milestone M6 (all milestones built). Colleagues on one subnet find each other with no configuration and chat
1:1 or in group chats over mutual-TLS links: rich text, mentions, reactions, replies, edits, pins,
polls, files of up to 4 TB sent at once from where they are (no copy, no waiting), toasts with inline reply, an Activity
feed and full-text search. Teams have owners and members, public or private visibility, standard
and private channels with threaded posts and announcements, and Files and Members tabs. Audio and
video calls (1:1 and mesh group calls up to 8 with video) run directly between PCs over WebRTC, with
screen sharing, hold, device choice and call history. Meetings can be started on the spot or
scheduled on a calendar (with repetition, RSVP, reminders and .ics export), and have meeting chat,
raised hands, reactions, organiser controls, background blur, local recording and a whiteboard.
Meetings that outgrow the mesh move to a media relay hosted by the best-placed participant's PC
(up to 100 people, with automatic hand-over if that PC goes away). Direct messages to a colleague
who is offline are sealed and left with other colleagues, who cannot read them. Offices with
several subnets are joined by typing one colleague's address. Profiles move between PCs in a
passphrase-protected file; updates come from a shared folder; Settings has diagnostics and a log
export.

## Quick start

Requires Windows 11, Node.js 24 and pnpm (`corepack enable`). No C++ toolchain is needed.

```bash
pnpm install
pnpm build      # typecheck, bundle the app, verify it contains no network origins
pnpm test       # unit and multi-peer integration tests (plus saved fuzz seeds)
pnpm test:fuzz  # randomised sync: 100 seeds of 10 peers and 2,000 events
pnpm e2e        # drives the real Electron app with two to eight profiles (fake camera and microphone)
pnpm dev        # build and launch with --profile=dev
pnpm sim --peers=3 --echo --lan=all   # three headless colleagues that answer your messages
pnpm sim --peers=0 --lite=200 --lan=all   # 200 lightweight colleagues, for scale testing
pnpm dist       # x64 and arm64 NSIS installers in apps/desktop/release (see docs/building-a-release.md)
node tools/sim/src/relay-load/run.ts --people=100 --minutes=30   # whole-office meeting on host relay
node tests/e2e/soak.ts --hours=24 --peers=50                      # 24-hour soak (after pnpm build)
```

### Signing and updates

`pnpm dist` signs the app and installers when `CSC_LINK` (a `.pfx` file) and `CSC_KEY_PASSWORD`
are set to the office's code-signing certificate. Without one the installers are unsigned, and
Windows SmartScreen shows "Windows protected your PC" on first run: choose More info, then Run
anyway. Installed builds look for new versions in this project's GitHub releases (about every
6 hours; the only time the app talks to the internet; Settings > Updates turns it off) and offer
"Install and restart" after checking the download against the SHA-256 GitHub publishes for it.
An office can instead (or as well) keep its installers in a shared folder named in Settings >
Updates, or built in (see docs/building-a-release.md): an update found there has to be installed
before the app is used further.
A signed build only accepts installers signed by the same publisher.

The installer adds Windows Firewall rules once (one administrator prompt): UDP 47800
(discovery), TCP 47801 (links) and, on x64, UDP/TCP 47802-47817 for the meeting relay worker.
`apps/desktop/resources/firewall.ps1` can add them for IT with `-Action add`.
The rules cover the Domain, Private and Public profiles, so nobody has to change their network
type to use InterCom.

Files are never copied by the sender: a shared file is served from where it is, and shows "File
is missing" if it is moved or deleted. Received files are saved to the folder chosen in
Settings > Files (default `Downloads\InterCom`).

Run several identities on one PC with `--profile=<name>`; data lives in
`%LOCALAPPDATA%\InterCom\<profile>` (override the root with `--data-root=<path>`).

To try chat on one PC without touching the office network, keep everything on loopback:

```bash
pnpm sim --peers=2 --echo --lan=loopback --discovery-port=47900
```

and start the app with `--lan=loopback --discovery-port=47900 --link-port=0`.

## Layout

| Path                             | What                                                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `packages/protocol`              | Zod schemas shared by core and UI: beacon, wire messages, events, IPC API                                            |
| `packages/core`                  | Identity, store and (from M1) discovery, links and sync. Plain Node, no Electron                                     |
| `apps/desktop/main`              | Electron main process and the utility-process host for the core                                                      |
| `apps/desktop/preload`           | Sandboxed preload exposing only the core's frame bridge                                                              |
| `apps/desktop/renderer`          | React and Fluent UI                                                                                                  |
| `tools/sim`                      | Launches N headless core peers; relay load test (`src/relay-load`)                                                   |
| `tools/scripts`                  | Origin and branding checks, protocol doc and icon generators, packaged smoke test                                    |
| `tests/integration`, `tests/e2e` | Multi-peer tests and Playwright for Electron                                                                         |
| `docs`                           | [decisions](docs/decisions.md), [protocol](docs/protocol.md), [manual tests](docs/manual-test.md), milestone reports |

## Ground rules

- The renderer talks to the core only through `@officemesh/protocol/ipc`; lint enforces it.
- The core imports no Electron code, and the renderer imports no Node code; lint enforces both.
- Every inbound network message is schema-validated and signature-checked before use.
- No internet: the build fails if the bundle contains a network origin, and the app blocks
  all http(s) and ws(s) requests at runtime.
