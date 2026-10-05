// Generates docs/protocol.md from the Zod schemas in packages/protocol.
// Run: pnpm docs:protocol. CI fails if the committed file is stale.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import * as p from '@officemesh/protocol';
import * as ipc from '@officemesh/protocol/ipc';

const out: string[] = [];
const line = (s = '') => out.push(s);
const schema = (title: string, s: z.ZodType) => {
  line(`#### ${title}`);
  line();
  line('```json');
  line(
    JSON.stringify(
      z.toJSONSchema(s, { unrepresentable: 'any', io: 'input', target: 'draft-2020-12' }),
      null,
      2,
    ),
  );
  line('```');
  line();
};

line('# OfficeMesh protocol');
line();
line('> Generated from `packages/protocol` by `pnpm docs:protocol`. Do not edit by hand.');
line();
line(`Protocol version: **${p.PROTOCOL_VERSION}**`);
line();
line(
  'Signed records (beacons, profiles, events) carry `sig`: an ECDSA P-256 / SHA-256 signature in IEEE P1363 form,',
);
line(
  'base64url, over the canonical JSON of every other field (keys sorted, no whitespace). Receivers verify the',
);
line('signature over the record exactly as received, then validate it against the schema below.');
line();

line('## 1. Discovery');
line();
line('| Constant | Value |');
line('| --- | --- |');
line(`| Multicast group | \`${p.BEACON_MULTICAST_GROUP}\` |`);
line(`| UDP port | ${p.BEACON_PORT} |`);
line(`| Default link port (TCP) | ${p.DEFAULT_LINK_PORT} |`);
line(`| Beacon interval | ${p.BEACON_INTERVAL_MS} ms |`);
line(`| Offline after | ${p.PEER_OFFLINE_AFTER_MS} ms without beacon or link |`);
line(`| Max clock skew | ${p.MAX_BEACON_CLOCK_SKEW_MS} ms |`);
line(`| Max beacon size | ${p.MAX_BEACON_BYTES} bytes |`);
line();
schema('Signed beacon', p.SignedBeacon);

line('## 2. Peer link');
line();
line('| Constant | Value |');
line('| --- | --- |');
line(`| Max text frame | ${p.MAX_TEXT_FRAME_BYTES} bytes |`);
line(
  `| Binary frame header | ${p.BINARY_FRAME_HEADER_BYTES} bytes (16-byte transfer ID, 8-byte big-endian offset) |`,
);
line(`| Ping interval | ${p.LINK_PING_INTERVAL_MS} ms (drop after two missed pongs) |`);
line(`| Idle close | ${p.LINK_IDLE_CLOSE_MS} ms |`);
line(`| Reconnect backoff | ${p.LINK_RECONNECT_BACKOFF_MS.join(', ')} ms |`);
line(`| Text frames per second | ${p.LINK_LIMITS.textFramesPerSecond} |`);
line(`| Open file transfers | ${p.LINK_LIMITS.openFileTransfers} |`);
line(`| Events per sync reply | ${p.LINK_LIMITS.eventsPerSyncReply} |`);
line(`| Ban after a limit is exceeded | ${p.ABUSE_BAN_MS} ms |`);
line();
line(`Capabilities advertised in \`hello\`: ${p.CAPABILITIES.map((c) => `\`${c}\``).join(', ')}`);
line();
schema('Envelope (one per text frame)', p.WireEnvelope);
line('### Message types');
line();
line('| Type | Body defined |');
line('| --- | --- |');
const wireBodies = p.WIRE_BODIES as Record<string, z.ZodType>;
for (const t of p.WIRE_TYPES) line(`| \`${t}\` | ${t in wireBodies ? 'yes' : 'not yet'} |`);
line();
for (const [t, s] of Object.entries(wireBodies)) schema(`\`${t}\` body`, s);

line('### Host relay methods (M6)');
line();
line(
  `\`relay.request\` carries one of these methods and its \`data\`; the host answers with \`relay.response\`. Limits: ${p.MAX_RELAY_PARTICIPANTS} people (${p.RELAY_CAPPED_PARTICIPANTS} without a relay-capable PC), the loudest ${p.RELAY_AUDIO_SPEAKERS} voices and ${p.RELAY_VIDEO_TILES} cameras per person, media ports from ${p.RELAY_PORT_BASE}, heartbeat every ${p.RELAY_HEARTBEAT_MS} ms, hand-over after ${p.RELAY_HOST_TIMEOUT_MS} ms of silence.`,
);
line();
for (const [m, s] of Object.entries(p.RELAY_REQUEST_DATA as Record<string, z.ZodType>))
  schema(`request \`${m}\` data`, s);
line('`relay.notify` carries one of these methods (several at once as `batch`):');
line();
for (const [m, s] of Object.entries(p.RELAY_NOTIFY_DATA as Record<string, z.ZodType>))
  schema(`notify \`${m}\` data`, s);

line('## 3. Profiles');
line();
schema('Signed profile', p.SignedProfile);

line('## 4. Conversation events');
line();
schema('Event', p.LogEvent);
line('### Event types');
line();
line('| Type | Body defined |');
line('| --- | --- |');
const eventBodies = p.EVENT_BODIES as Record<string, z.ZodType>;
for (const t of p.EVENT_TYPES) line(`| \`${t}\` | ${t in eventBodies ? 'yes' : 'not yet'} |`);
line();
for (const [t, s] of Object.entries(eventBodies)) schema(`\`${t}\` body`, s);

line('## 5. Renderer ↔ core IPC');
line();
line(
  "Frames on the renderer's MessagePort. Commands go in as `req`, results come back as `res`, and the core pushes `evt`.",
);
line();
schema('Frame', ipc.IpcFrame);
line('### Commands');
line();
for (const [name, c] of Object.entries(ipc.ipcCommands)) {
  schema(`\`${name}\` input`, c.input);
  schema(`\`${name}\` output`, c.output);
}
line('### Events');
line();
for (const [name, s] of Object.entries(ipc.ipcEvents)) schema(`\`${name}\``, s);

const target = resolve(import.meta.dirname, '../../docs/protocol.md');
writeFileSync(target, out.join('\n'));
console.log(`wrote ${target}`);
