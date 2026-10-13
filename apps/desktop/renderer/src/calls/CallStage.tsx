import { useEffect, useRef, useState } from 'react';
import {
  Avatar,
  Button,
  makeStyles,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  mergeClasses,
  Text,
  tokens,
} from '@fluentui/react-components';
import {
  ShieldCheckmark20Regular,
  HandRight20Filled,
  MoreHorizontal20Regular,
} from '@fluentui/react-icons';
import type { CallParticipantView, CallView } from '@officemesh/protocol/ipc';
import { avatarSrc, useApp } from '../state.ts';
import { strings } from '../strings.ts';
import { control, setCameraPage, toggleHold, useCall, videoSenders } from './engine.ts';
import { MeetingChat } from './MeetingChat.tsx';
import { CallToolbar } from './CallToolbar.tsx';
import { PeoplePanel } from './PeoplePanel.tsx';
import { ResizeHandle, useResizableWidth } from '../shell/Resizer.tsx';
import { ControlLayer, RemoteChip, RemotePrompt, SharedPointers } from './RemoteControl.tsx';
import { useRemote } from './remote.ts';
import { Whiteboard } from './Whiteboard.tsx';
import { useWhiteboard } from './whiteboard.ts';

const useStyles = makeStyles({
  stage: {
    position: 'relative',
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    minHeight: 0,
    overflow: 'hidden',
    background: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground1,
  },
  top: {
    flex: 'none',
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL}`,
  },
  grow: { flex: 1 },
  // Whatever the people show, it stays inside this box: the control bar below never moves.
  body: {
    flex: 1,
    display: 'flex',
    minHeight: 0,
    overflow: 'hidden',
    padding: tokens.spacingHorizontalM,
    gap: tokens.spacingHorizontalM,
  },
  main: {
    flex: 1,
    display: 'flex',
    minWidth: 0,
    minHeight: 0,
    overflow: 'hidden',
    gap: tokens.spacingHorizontalM,
  },
  shared: { flex: 3, display: 'flex', minWidth: 0, minHeight: 0 },
  grid: {
    flex: 1,
    display: 'grid',
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
    minHeight: 0,
  },
  // The people beside a shared screen share the height they are given: each tile shrinks to fit
  // (down to a small minimum, then the strip scrolls) instead of running off the window.
  strip: {
    flex: 'none',
    width: '220px',
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    overflowY: 'auto',
  },
  panel: {
    flex: 'none',
    minHeight: 0,
    display: 'flex',
    borderRadius: tokens.borderRadiusLarge,
    overflow: 'hidden',
    boxShadow: tokens.shadow4,
  },
  tile: {
    position: 'relative',
    aspectRatio: '16 / 9',
    borderRadius: tokens.borderRadiusLarge,
    background: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    overflow: 'hidden',
    display: 'grid',
    placeItems: 'center',
    border: '2px solid transparent',
    ':hover .om-tile-menu': { opacity: 1 },
  },
  // In the gallery a tile fills its cell, so the grid is as tall as the window allows.
  tileStrip: {
    aspectRatio: 'auto',
    flex: '1 1 0',
    minHeight: '64px',
    maxHeight: '124px',
    width: '100%',
  },
  // Stretches to its grid cell: a height of its own would make every row as tall as the grid.
  tileFill: { aspectRatio: 'auto', minHeight: 0 },
  speaking: { border: `2px solid ${tokens.colorBrandStroke1}` },
  video: { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' },
  screenVideo: {
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    background: tokens.colorNeutralBackground6,
    borderRadius: tokens.borderRadiusLarge,
  },
  label: {
    position: 'absolute',
    left: '8px',
    bottom: '8px',
    padding: '2px 8px',
    borderRadius: tokens.borderRadiusMedium,
    background: 'rgba(0,0,0,0.6)',
    color: '#ffffff',
    fontSize: tokens.fontSizeBase200,
    display: 'flex',
    alignItems: 'center',
    columnGap: '4px',
  },
  tileMenu: {
    position: 'absolute',
    top: '6px',
    right: '6px',
    opacity: 0,
    ':focus-within': { opacity: 1 },
  },
  reaction: {
    position: 'absolute',
    top: '12px',
    left: '12px',
    fontSize: '40px',
    animationName: {
      from: { transform: 'translateY(20px)', opacity: 0 },
      '20%': { transform: 'translateY(0)', opacity: 1 },
      to: { transform: 'translateY(-30px)', opacity: 0 },
    },
    animationDuration: '3s',
    animationFillMode: 'forwards',
  },
  hand: { color: '#ffb900' },
  bar: {
    flex: 'none',
    position: 'relative',
    zIndex: 2,
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalM,
    background: tokens.colorNeutralBackground3,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  control: { minWidth: '44px' },
  // What is going on in the call (recording, sharing, on hold, ...): small chips in the control
  // bar, so the picture below keeps all the room.
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalXS,
    flex: '0 1 auto',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: '100%',
    minHeight: '24px',
    padding: `0 ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusCircular,
    background: tokens.colorNeutralBackground5,
    color: tokens.colorNeutralForeground1,
    fontSize: tokens.fontSizeBase200,
  },
  chipRecording: { background: '#a4262c', color: '#ffffff', fontWeight: 600 },
  reactions: { display: 'flex', gap: '4px' },
  reactionButton: { fontSize: '22px', minWidth: '40px' },
});

function MediaVideo({
  stream,
  mirror,
  className,
}: {
  stream: MediaStream;
  mirror?: boolean;
  className: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <video
      ref={ref}
      className={className}
      autoPlay
      playsInline
      muted
      style={mirror ? { transform: 'scaleX(-1)' } : undefined}
    />
  );
}

/** The organiser's menu on a participant's tile. */
function TileMenu({ p, spotlit }: { p: CallParticipantView; spotlit: boolean }) {
  const s = useStyles();
  return (
    <div className={mergeClasses('om-tile-menu', s.tileMenu)}>
      <Menu>
        <MenuTrigger disableButtonEnhancement>
          <Button
            size="small"
            appearance="subtle"
            icon={<MoreHorizontal20Regular />}
            aria-label={strings.inCall.more}
            data-testid="tile-menu"
          />
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            <MenuItem onClick={() => control('mute', p.userId)} data-testid="tile-mute">
              {strings.inCall.mute}
            </MenuItem>
            <MenuItem
              onClick={() => control('spotlight', spotlit ? null : p.userId)}
              data-testid="tile-spotlight"
            >
              {spotlit ? strings.inCall.stopSpotlight : strings.inCall.spotlight}
            </MenuItem>
            <MenuItem onClick={() => control('remove', p.userId)} data-testid="tile-remove">
              {strings.inCall.remove}
            </MenuItem>
          </MenuList>
        </MenuPopover>
      </Menu>
    </div>
  );
}

function Tile({
  p,
  showVideo,
  organizerView,
  spotlit,
  relayed,
  fill,
  strip,
}: {
  p: CallParticipantView;
  showVideo: boolean;
  /** Fill the cell it is in (the gallery) instead of keeping a 16:9 shape. */
  fill?: boolean;
  /** In the strip beside a shared screen: shrinks with the height it is given. */
  strip?: boolean;
  organizerView?: boolean;
  spotlit?: boolean;
  /** On host relay: one connection to the host, not one per person. */
  relayed?: { reconnecting: boolean };
}) {
  const s = useStyles();
  const selfId = useApp((st) => st.identity?.userId);
  const self = p.userId === selfId;
  const remote = useCall((st) => st.remotes[p.userId]);
  const preview = useCall((st) => st.preview);
  const camera = useCall((st) => st.camera);
  const allReactions = useCall((st) => st.reactions);
  const reactions = allReactions.filter((r) => r.from === p.userId);
  const speaking = useCall((st) =>
    self ? st.speaking : (st.remotes[p.userId]?.speaking ?? false),
  );
  const stream = self ? (camera ? preview : undefined) : remote?.camera;
  const hasVideo =
    showVideo && (self ? camera : p.video) && stream && stream.getVideoTracks().length > 0;
  const connecting = relayed ? relayed.reconnecting : !self && remote?.state !== 'connected';
  return (
    <div
      className={mergeClasses(
        s.tile,
        fill && s.tileFill,
        strip && s.tileStrip,
        speaking && s.speaking,
      )}
      data-testid="call-tile"
      data-user={p.userId}
      data-state={self ? 'self' : (remote?.state ?? 'new')}
      data-video={hasVideo ? 'on' : 'off'}
      data-hand={p.hand ? 'up' : 'down'}
    >
      {hasVideo ? (
        <MediaVideo stream={stream} mirror={self} className={s.video} />
      ) : (
        <Avatar name={p.name} size={72} color="colorful" image={avatarSrc(p.avatarHash)} />
      )}
      {reactions.map((r) => (
        <span key={r.id} className={s.reaction} data-testid="reaction">
          {r.emoji}
        </span>
      ))}
      <span className={s.label}>
        {p.hand && <HandRight20Filled className={s.hand} aria-label={strings.inCall.handRaised} />}
        {self ? strings.calls.you : p.name}
        {spotlit ? ` · ${strings.inCall.spotlit}` : ''}
        {p.muted ? ` · ${strings.calls.muted}` : ''}
        {p.onHold ? ` · ${strings.calls.onHold}` : ''}
        {connecting ? ` · ${strings.calls.connecting}` : ''}
      </span>
      {organizerView && !self && <TileMenu p={p} spotlit={spotlit === true} />}
    </div>
  );
}

function useDuration(since: number | undefined): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(t);
  }, []);
  return since ? strings.calls.duration(Math.max(0, now - since)) : '';
}

/** Who to show on the main stage: whoever shares, else the people in the call. */
function useSharer() {
  const selfId = useApp((st) => st.identity?.userId);
  const call = useCall((st) => st.call);
  const remotes = useCall((st) => st.remotes);
  const localScreen = useCall((st) => st.localScreen);
  const sharer = call?.participants.find((p) =>
    p.userId === selfId ? !!localScreen : p.sharing && !!remotes[p.userId]?.screen,
  );
  const stream = sharer
    ? sharer.userId === selfId
      ? localScreen
      : remotes[sharer.userId]?.screen
    : undefined;
  return { sharer, stream, self: sharer?.userId === selfId };
}

/** The participant the organiser spotlit, if any. */
function spotlightOf(call: CallView): string | undefined {
  const s = call.participants.find((p) => p.userId === call.organizer)?.spotlight;
  return s && call.participants.some((p) => p.userId === s) ? s : undefined;
}

export function CallStage() {
  const s = useStyles();
  const call = useCall((st) => st.call);
  const onHold = useCall((st) => st.onHold);
  const error = useCall((st) => st.error);
  const message = useCall((st) => st.message);
  const layout = useCall((st) => st.layout);
  const chatOpen = useCall((st) => st.chatOpen);
  const board = useWhiteboard((st) => st.open);
  const selfId = useApp((st) => st.identity?.userId);
  const duration = useDuration(call?.answeredAt);
  const { sharer, stream, self } = useSharer();
  const remotes = useCall((st) => st.remotes);
  const relayStats = useCall((st) => st.relayStats);
  const page = useCall((st) => st.page);
  const cameraCount = useCall((st) => st.cameraCount);
  const peopleOpen = useCall((st) => st.peopleOpen);
  const convKind = useApp((st) => (call?.convId ? st.conversations[call.convId]?.kind : undefined));
  const panel = useResizableWidth('call-panel', 340, 260, 640, 'left');
  const controlling = useRemote((st) => st.phase === 'controlling' && st.peer === sharer?.userId);
  if (!call || call.state === 'ringing') return null;
  // The chat in the window: the call's own group once there are three or more (and the
  // one-to-one chat leaves), the conversation the call belongs to before that.
  const chatConvId =
    call.chat ??
    (call.convId && convKind && (convKind !== 'direct' || call.participants.length < 3)
      ? call.convId
      : undefined);
  const senders = videoSenders(call);
  const relay = call.relay;
  // A large relayed meeting shows you, the people whose cameras you receive and whoever is
  // speaking; everyone else is counted in one "+N" tile.
  const shownLimit = 16;
  const people =
    relay && call.participants.length > shownLimit
      ? call.participants
          .filter(
            (p) =>
              p.userId === selfId ||
              p.userId === sharer?.userId ||
              !!remotes[p.userId]?.camera ||
              remotes[p.userId]?.speaking,
          )
          .slice(0, shownLimit)
      : call.participants;
  const hidden = call.participants.length - people.length;
  const organizerView = call.organizer === selfId;
  const spotlight = spotlightOf(call);
  const recorders = people
    .filter((p) => p.recording)
    .map((p) => (p.userId === selfId ? strings.calls.you : p.name));
  // Speaker view (or a spotlight): one person large, the rest in a strip.
  const focusId =
    spotlight ??
    (layout === 'speaker'
      ? [...people]
          .filter((p) => p.userId !== selfId)
          .sort((a, b) => b.lastSpokeAt - a.lastSpokeAt)[0]?.userId
      : undefined);
  const focus = focusId ? people.find((p) => p.userId === focusId) : undefined;
  const cells = people.length + (hidden > 0 ? 1 : 0);
  const columns = Math.ceil(Math.sqrt(cells));
  const rows = Math.ceil(cells / columns);
  const pages = Math.max(1, Math.ceil(cameraCount / 9));
  const waiting =
    call.state === 'outgoing'
      ? strings.calls.calling(
          call.invited
            .map((u) => useApp.getState().people[u]?.displayName ?? '')
            .filter(Boolean)
            .join(', ') || strings.calls.people(call.invited.length),
        )
      : '';
  const tile = (p: CallParticipantView, mode: boolean | 'strip' = false) => (
    <Tile
      key={p.userId}
      p={p}
      fill={mode === true}
      strip={mode === 'strip'}
      showVideo={relay ? true : senders.has(p.userId)}
      organizerView={organizerView}
      spotlit={p.userId === spotlight}
      {...(relay && { relayed: { reconnecting: relay.reconnecting } })}
    />
  );
  const more =
    hidden > 0 ? (
      <div className={mergeClasses(s.tile, s.tileFill)} data-testid="call-more-people">
        <Text size={500} weight="semibold">
          {strings.relay.more(hidden)}
        </Text>
      </div>
    ) : null;
  return (
    <section
      className={s.stage}
      aria-label={strings.calls.videoCall}
      data-testid="call-stage"
      data-call={call.callId}
    >
      <CallToolbar
        left={
          <>
            <ShieldCheckmark20Regular aria-hidden="true" />
            <Text data-testid="call-time">{waiting || duration}</Text>
            {relay && relay.max < 100 && (
              <Text size={200} data-testid="relay-capped">
                {strings.relay.capped(relay.max)}
              </Text>
            )}
            {relay && pages > 1 && (
              <>
                <Button
                  size="small"
                  appearance="subtle"
                  disabled={page === 0}
                  onClick={() => setCameraPage(page - 1)}
                >
                  {strings.relay.previous}
                </Button>
                <Text size={200}>{strings.relay.page(page + 1, pages)}</Text>
                <Button
                  size="small"
                  appearance="subtle"
                  disabled={page >= pages - 1}
                  onClick={() => setCameraPage(page + 1)}
                >
                  {strings.relay.next}
                </Button>
              </>
            )}
            {message && (
              <Text size={200} data-testid="call-message" truncate wrap={false}>
                {message}
              </Text>
            )}
            {error && (
              <Text size={200} truncate wrap={false}>
                {error}
              </Text>
            )}
            {recorders.length > 0 && (
              <div
                className={mergeClasses(s.chip, s.chipRecording)}
                role="status"
                data-testid="recording-banner"
              >
                ● {strings.inCall.recordingBanner(recorders.join(', '))}
              </div>
            )}
            {onHold && (
              <div className={s.chip} data-testid="hold-banner">
                {call.held ? strings.incoming.heldBanner : strings.calls.youAreOnHold}
                {call.held && (
                  <Button
                    size="small"
                    appearance="primary"
                    onClick={toggleHold}
                    data-testid="call-resume"
                  >
                    {strings.calls.resume}
                  </Button>
                )}
              </div>
            )}
            {relay?.reconnecting && (
              <div className={s.chip} role="status" data-testid="relay-reconnecting">
                {strings.relay.reconnecting}
              </div>
            )}
            {relay && relay.host === selfId && relayStats && (
              <div className={s.chip} data-testid="relay-host-stats">
                {strings.relay.hosting(
                  relayStats.participants,
                  relayStats.cpuPercent,
                  relayStats.sendMbps,
                )}
              </div>
            )}
            {sharer && !board && (
              <div className={s.chip} data-testid="share-banner">
                {self ? strings.calls.youAreSharing : strings.calls.sharing(sharer.name)}
              </div>
            )}
            <RemoteChip />
          </>
        }
      />
      <RemotePrompt />
      <div className={s.body}>
        <div className={s.main}>
          {board ? (
            <Whiteboard convId={call.convId} />
          ) : stream ? (
            <>
              <div
                className={s.shared}
                data-testid="shared-screen"
                style={{ position: 'relative' }}
              >
                <MediaVideo stream={stream} className={s.screenVideo} />
                {sharer && !self && <SharedPointers sharerId={sharer.userId} />}
                {controlling && sharer && <ControlLayer />}
              </div>
              <div className={s.strip}>{people.map((p) => tile(p, 'strip'))}</div>
            </>
          ) : focus ? (
            <>
              <div className={s.shared} data-testid="speaker-focus" data-user={focus.userId}>
                <div style={{ width: '100%', height: '100%', display: 'grid' }}>
                  {tile(focus, true)}
                </div>
              </div>
              <div className={s.strip}>{people.filter((p) => p !== focus).map((p) => tile(p))}</div>
            </>
          ) : (
            <div
              className={s.grid}
              style={{
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
              }}
            >
              {people.map((p) => tile(p, true))}
              {more}
            </div>
          )}
        </div>
        {(chatOpen || peopleOpen) && (
          <>
            <ResizeHandle
              props={panel.handleProps}
              dragging={panel.dragging}
              label={strings.inCall.resizePanel}
              testId="call-panel-resize"
            />
            <div className={s.panel} style={{ width: panel.width }} data-testid="call-side-panel">
              {peopleOpen ? (
                <PeoplePanel call={call} organizerView={organizerView} spotlight={spotlight} />
              ) : (
                <MeetingChat convId={chatConvId} />
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
