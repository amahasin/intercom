# OfficeMesh

Workplace chat, calls and meetings for an office LAN, with no server. Every Windows 11 PC
running OfficeMesh is an equal peer: colleagues find each other automatically, and nothing
ever leaves the local network.

**Status:** milestone M3. Colleagues on one subnet find each other with no configuration and chat
1:1 or in group chats over mutual-TLS links: rich text, mentions, reactions, replies, edits, pins,
polls, files of up to 2 GB pulled from whoever holds them, toasts with inline reply, an Activity
feed and full-text search. Teams have owners and members, public or private visibility, standard
and private channels with threaded posts and announcements, and Files and Members tabs. Every
member relays what others missed, so messages arrive even when their author is offline.

## Quick start

Requires Windows 11, Node.js 24 and pnpm (`corepack enable`). No C++ toolchain is needed.

```bash
pnpm install
pnpm build      # typecheck, bundle the app, verify it contains no network origins
pnpm test       # unit and multi-peer integration tests (plus saved fuzz seeds)
pnpm test:fuzz  # randomised sync: 100 seeds of 10 peers and 2,000 events
pnpm e2e        # drives the real Electron app with two profiles
pnpm dev        # build and launch with --profile=dev
pnpm sim --peers=3 --echo         # three headless colleagues that answer your messages
pnpm sim --peers=0 --lite=200     # 200 lightweight colleagues, for scale testing
pnpm dist       # x64 and arm64 NSIS installers in apps/desktop/release
```

Run several identities on one PC with `--profile=<name>`; data lives in
`%LOCALAPPDATA%\OfficeMesh\<profile>` (override the root with `--data-root=<path>`).

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
| `tools/sim`                      | Launches N headless core peers                                                                                       |
| `tools/scripts`                  | Origin and branding checks, protocol doc and icon generators, packaged smoke test                                    |
| `tests/integration`, `tests/e2e` | Multi-peer tests and Playwright for Electron                                                                         |
| `docs`                           | [decisions](docs/decisions.md), [protocol](docs/protocol.md), [manual tests](docs/manual-test.md), milestone reports |

## Ground rules

- The renderer talks to the core only through `@officemesh/protocol/ipc`; lint enforces it.
- The core imports no Electron code, and the renderer imports no Node code; lint enforces both.
- Every inbound network message is schema-validated and signature-checked before use.
- No internet: the build fails if the bundle contains a network origin, and the app blocks
  all http(s) and ws(s) requests at runtime.
