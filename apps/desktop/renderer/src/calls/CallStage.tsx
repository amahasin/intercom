import { useEffect, useRef, useState } from 'react';
import {
  Avatar,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  makeStyles,
  Menu,
  MenuDivider,
  MenuGroup,
  MenuGroupHeader,
  MenuItem,
  MenuItemRadio,
  MenuList,
  MenuPopover,
  MenuTrigger,
  mergeClasses,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  Text,
  tokens,
  Tooltip,
} from '@fluentui/react-components';
import {
  ArrowMaximize20Regular,
  ArrowMinimize20Regular,
  CallEnd20Filled,
  Chat20Regular,
  Emoji20Regular,
  HandRight20Filled,
  HandRight20Regular,
  Mic20Regular,
  MicOff20Regular,
  MoreHorizontal20Regular,
  PersonAdd20Regular,
  Record20Regular,
  ShareScreenStart20Regular,
  ShareScreenStop20Regular,
  PauseCircle20Regular,
  PlayCircle20Regular,
  Video20Regular,
  VideoOff20Regular,
  Whiteboard20Regular,
} from '@fluentui/react-icons';
import { CALL_REACTIONS } from '@officemesh/protocol';
import type { CallParticipantView, CallView } from '@officemesh/protocol/ipc';
import { PeoplePicker } from '../people/PeoplePicker.tsx';
import { avatarSrc, useApp } from '../state.ts';
import { strings } from '../strings.ts';
import {
  control,
  hangUp,
  inviteToCall,
  react,
  setBlur,
  setCallView,
  setChatOpen,
  setLayout,
  startRecording,
  stopRecording,
  stopShare,
  switchDevice,
  toggleCamera,
  toggleHand,
  toggleHold,
  toggleMute,
  useCall,
  videoSenders,
} from './engine.ts';
import { MeetingChat } from './MeetingChat.tsx';
import { ScreenPicker } from './ScreenPicker.tsx';
import { Whiteboard } from './Whiteboard.tsx';
import { setWhiteboardOpen, useWhiteboard } from './whiteboard.ts';

const useStyles = makeStyles({
  stage: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    minHeight: 0,
    background: '#1b1a19',
    color: '#ffffff',
  },
  top: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL}`,
  },
  grow: { flex: 1 },
  body: {
    flex: 1,
    display: 'flex',
    minHeight: 0,
    padding: tokens.spacingHorizontalM,
    gap: tokens.spacingHorizontalM,
  },
  main: { flex: 1, display: 'flex', minWidth: 0, minHeight: 0, gap: tokens.spacingHorizontalM },
  shared: { flex: 3, display: 'flex', minWidth: 0 },
  grid: {
    flex: 1,
    display: 'grid',
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
    alignContent: 'center',
  },
  strip: {
    flex: 1,
    maxWidth: '240px',
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    overflowY: 'auto',
  },
  tile: {
    position: 'relative',
    aspectRatio: '16 / 9',
    borderRadius: tokens.borderRadiusLarge,
    background: '#2d2c2b',
    overflow: 'hidden',
    display: 'grid',
    placeItems: 'center',
    border: '2px solid transparent',
    ':hover .om-tile-menu': { opacity: 1 },
  },
  speaking: { border: `2px solid ${tokens.colorBrandStroke1}` },
  video: { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' },
  screenVideo: { width: '100%', height: '100%', objectFit: 'contain', background: '#000' },
  label: {
    position: 'absolute',
    left: '8px',
    bottom: '8px',
    padding: '2px 8px',
    borderRadius: tokens.borderRadiusMedium,
    background: 'rgba(0,0,0,0.55)',
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
    display: 'flex',
    justifyContent: 'center',
    columnGap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalM,
  },
  control: { minWidth: '44px' },
  banner: { textAlign: 'center', padding: tokens.spacingVerticalXS, background: '#605e5c' },
  recording: {
    textAlign: 'center',
    padding: tokens.spacingVerticalXS,
    background: '#a4262c',
    fontWeight: 600,
  },
  mini: {
    position: 'fixed',
    right: '20px',
    bottom: '20px',
    width: '300px',
    zIndex: 1000,
    borderRadius: tokens.borderRadiusXLarge,
    overflow: 'hidden',
    boxShadow: tokens.shadow28,
    background: '#1b1a19',
    color: '#ffffff',
  },
  miniBar: {
    display: 'flex',
    justifyContent: 'center',
    columnGap: tokens.spacingHorizontalXS,
    padding: tokens.spacingVerticalXS,
  },
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
}: {
  p: CallParticipantView;
  showVideo: boolean;
  organizerView?: boolean;
  spotlit?: boolean;
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
  const connecting = !self && remote?.state !== 'connected';
  return (
    <div
      className={mergeClasses(s.tile, speaking && s.speaking)}
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

function DevicesMenu() {
  const settings = useApp((st) => st.settings);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    void navigator.mediaDevices.enumerateDevices().then(setDevices);
  }, []);
  const group = (
    kind: MediaDeviceKind,
    key: 'audioInput' | 'videoInput' | 'audioOutput',
    title: string,
  ) => {
    const list = devices.filter(
      (d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications',
    );
    return (
      <MenuGroup>
        <MenuGroupHeader>{title}</MenuGroupHeader>
        <MenuItemRadio name={key} value="" onClick={() => void switchDevice(key, '')}>
          {strings.calls.systemDefault}
        </MenuItemRadio>
        {list.map((d) => (
          <MenuItemRadio
            key={d.deviceId}
            name={key}
            value={d.deviceId}
            onClick={() => void switchDevice(key, d.deviceId)}
          >
            {d.label || d.deviceId.slice(0, 8)}
          </MenuItemRadio>
        ))}
      </MenuGroup>
    );
  };
  return (
    <Menu
      checkedValues={{
        audioInput: [settings?.audioInput ?? ''],
        videoInput: [settings?.videoInput ?? ''],
        audioOutput: [settings?.audioOutput ?? ''],
      }}
    >
      <MenuTrigger disableButtonEnhancement>
        <MenuItem>{strings.inCall.devices}</MenuItem>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          {group('audioinput', 'audioInput', strings.calls.microphone)}
          <MenuDivider />
          {group('audiooutput', 'audioOutput', strings.calls.speaker)}
          <MenuDivider />
          {group('videoinput', 'videoInput', strings.calls.camera)}
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}

function Controls({ compact }: { compact?: boolean }) {
  const s = useStyles();
  const call = useCall((st) => st.call)!;
  const selfId = useApp((st) => st.identity?.userId);
  const muted = useCall((st) => st.muted);
  const camera = useCall((st) => st.camera);
  const sharing = useCall((st) => st.sharing);
  const onHold = useCall((st) => st.onHold);
  const blur = useCall((st) => st.blur);
  const recording = useCall((st) => st.recording);
  const layout = useCall((st) => st.layout);
  const chatOpen = useCall((st) => st.chatOpen);
  const board = useWhiteboard((st) => st.open);
  const hand = call.participants.find((p) => p.userId === selfId)?.hand === true;
  const organizer = call.organizer === selfId;
  const [picking, setPicking] = useState(false);
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const button = (
    label: string,
    icon: React.ReactElement,
    onClick: () => void,
    testId: string,
    extra?: object,
  ) => (
    <Tooltip content={label} relationship="label">
      <Button
        className={s.control}
        appearance="secondary"
        icon={icon}
        aria-label={label}
        onClick={onClick}
        data-testid={testId}
        {...extra}
      />
    </Tooltip>
  );
  return (
    <>
      {button(
        muted ? strings.calls.unmute : strings.calls.mute,
        muted ? <MicOff20Regular /> : <Mic20Regular />,
        toggleMute,
        'call-mute',
        { 'aria-pressed': muted },
      )}
      {call.media === 'video' &&
        button(
          camera ? strings.calls.cameraOff : strings.calls.cameraOn,
          camera ? <Video20Regular /> : <VideoOff20Regular />,
          () => void toggleCamera(),
          'call-camera',
          { 'aria-pressed': camera },
        )}
      {!compact &&
        button(
          sharing ? strings.calls.stopShare : strings.calls.share,
          sharing ? <ShareScreenStop20Regular /> : <ShareScreenStart20Regular />,
          () => (sharing ? void stopShare() : setPicking(true)),
          'call-share',
          { 'aria-pressed': sharing },
        )}
      {!compact &&
        button(
          hand ? strings.inCall.lowerHand : strings.inCall.raiseHand,
          hand ? <HandRight20Filled /> : <HandRight20Regular />,
          toggleHand,
          'call-hand',
          { 'aria-pressed': hand },
        )}
      {!compact && (
        <Popover positioning="above" withArrow>
          <PopoverTrigger disableButtonEnhancement>
            <Tooltip content={strings.inCall.react} relationship="label">
              <Button
                className={s.control}
                appearance="secondary"
                icon={<Emoji20Regular />}
                aria-label={strings.inCall.react}
                data-testid="call-react"
              />
            </Tooltip>
          </PopoverTrigger>
          <PopoverSurface>
            <div className={s.reactions}>
              {CALL_REACTIONS.map((e) => (
                <Button
                  key={e}
                  appearance="subtle"
                  className={s.reactionButton}
                  onClick={() => react(e)}
                  data-testid={`react-${e}`}
                >
                  {e}
                </Button>
              ))}
            </div>
          </PopoverSurface>
        </Popover>
      )}
      {!compact &&
        call.convId &&
        button(strings.inCall.chat, <Chat20Regular />, () => setChatOpen(!chatOpen), 'call-chat', {
          'aria-pressed': chatOpen,
        })}
      {!compact &&
        button(
          strings.inCall.whiteboard,
          <Whiteboard20Regular />,
          () => setWhiteboardOpen(!board),
          'call-whiteboard',
          { 'aria-pressed': board },
        )}
      {!compact && (
        <Menu>
          <MenuTrigger disableButtonEnhancement>
            <Tooltip content={strings.inCall.more} relationship="label">
              <Button
                className={s.control}
                appearance="secondary"
                icon={<MoreHorizontal20Regular />}
                aria-label={strings.inCall.more}
                data-testid="call-more"
              />
            </Tooltip>
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              {call.media === 'video' && (
                <MenuItem
                  onClick={() => void setBlur(!blur)}
                  data-testid="call-blur"
                  disabled={!camera}
                >
                  {blur ? strings.inCall.blurOff : strings.inCall.blurOn}
                </MenuItem>
              )}
              <MenuItem
                icon={<Record20Regular />}
                onClick={() => void (recording ? stopRecording() : startRecording())}
                data-testid="call-record"
              >
                {recording ? strings.inCall.stopRecord : strings.inCall.record}
              </MenuItem>
              <MenuItem
                onClick={() => setLayout(layout === 'gallery' ? 'speaker' : 'gallery')}
                data-testid="call-layout"
              >
                {layout === 'gallery' ? strings.inCall.speaker : strings.inCall.gallery}
              </MenuItem>
              <MenuItem
                onClick={toggleHold}
                data-testid="call-hold"
                icon={onHold ? <PlayCircle20Regular /> : <PauseCircle20Regular />}
              >
                {onHold ? strings.calls.resume : strings.calls.hold}
              </MenuItem>
              <MenuItem
                onClick={() => setAdding(true)}
                data-testid="call-add"
                icon={<PersonAdd20Regular />}
              >
                {strings.calls.addPeople}
              </MenuItem>
              {organizer && (
                <MenuItem onClick={() => control('mute', null)} data-testid="call-mute-all">
                  {strings.inCall.muteAll}
                </MenuItem>
              )}
              <DevicesMenu />
            </MenuList>
          </MenuPopover>
        </Menu>
      )}
      {compact &&
        button(
          onHold ? strings.calls.resume : strings.calls.hold,
          onHold ? <PlayCircle20Regular /> : <PauseCircle20Regular />,
          toggleHold,
          'call-hold',
        )}
      {button(
        compact ? strings.calls.expand : strings.calls.minimize,
        compact ? <ArrowMaximize20Regular /> : <ArrowMinimize20Regular />,
        () => setCallView(compact ? 'full' : 'mini'),
        compact ? 'call-expand' : 'call-minimize',
      )}
      <Tooltip content={strings.calls.hangUp} relationship="label">
        <Button
          icon={<CallEnd20Filled />}
          aria-label={strings.calls.hangUp}
          onClick={hangUp}
          data-testid="call-hangup"
          style={{ background: tokens.colorPaletteRedBackground3, color: '#fff' }}
        >
          {compact ? '' : strings.calls.hangUp}
        </Button>
      </Tooltip>
      {picking && <ScreenPicker onClose={() => setPicking(false)} />}
      {adding && (
        <Dialog open onOpenChange={(_e, d) => !d.open && setAdding(false)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>{strings.calls.addPeople}</DialogTitle>
              <DialogContent>
                <PeoplePicker
                  selected={picked}
                  onChange={setPicked}
                  exclude={call.participants.map((p) => p.userId)}
                />
              </DialogContent>
              <DialogActions>
                <Button onClick={() => setAdding(false)}>{strings.me.cancel}</Button>
                <Button
                  appearance="primary"
                  disabled={picked.length === 0}
                  onClick={() => {
                    inviteToCall(picked);
                    setPicked([]);
                    setAdding(false);
                  }}
                >
                  {strings.groups.add}
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      )}
    </>
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
  if (!call || call.state === 'ringing') return null;
  const senders = videoSenders(call);
  const people = call.participants;
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
  const columns = Math.ceil(Math.sqrt(people.length));
  const waiting =
    call.state === 'outgoing'
      ? strings.calls.calling(
          call.invited
            .map((u) => useApp.getState().people[u]?.displayName ?? '')
            .filter(Boolean)
            .join(', ') || strings.calls.people(call.invited.length),
        )
      : '';
  const tile = (p: CallParticipantView) => (
    <Tile
      key={p.userId}
      p={p}
      showVideo={senders.has(p.userId)}
      organizerView={organizerView}
      spotlit={p.userId === spotlight}
    />
  );
  return (
    <section
      className={s.stage}
      aria-label={strings.calls.videoCall}
      data-testid="call-stage"
      data-call={call.callId}
    >
      <div className={s.top}>
        <Text weight="semibold">{strings.calls.people(people.length)}</Text>
        <Text>{waiting || duration}</Text>
        <span className={s.grow} />
        {message && (
          <Text size={200} data-testid="call-message">
            {message}
          </Text>
        )}
        {error && <Text size={200}>{error}</Text>}
      </div>
      {recorders.length > 0 && (
        <div className={s.recording} role="status" data-testid="recording-banner">
          ● {strings.inCall.recordingBanner(recorders.join(', '))}
        </div>
      )}
      {onHold && <div className={s.banner}>{strings.calls.youAreOnHold}</div>}
      {sharer && !board && (
        <div className={s.banner} data-testid="share-banner">
          {self ? strings.calls.youAreSharing : strings.calls.sharing(sharer.name)}
        </div>
      )}
      <div className={s.body}>
        <div className={s.main}>
          {board ? (
            <Whiteboard convId={call.convId} />
          ) : stream ? (
            <>
              <div className={s.shared} data-testid="shared-screen">
                <MediaVideo stream={stream} className={s.screenVideo} />
              </div>
              <div className={s.strip}>{people.map(tile)}</div>
            </>
          ) : focus ? (
            <>
              <div className={s.shared} data-testid="speaker-focus" data-user={focus.userId}>
                <div style={{ width: '100%', alignSelf: 'center' }}>{tile(focus)}</div>
              </div>
              <div className={s.strip}>{people.filter((p) => p !== focus).map(tile)}</div>
            </>
          ) : (
            <div
              className={s.grid}
              style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
            >
              {people.map(tile)}
            </div>
          )}
        </div>
        {chatOpen && call.convId && <MeetingChat convId={call.convId} />}
      </div>
      <div className={s.bar}>
        <Controls />
      </div>
    </section>
  );
}

/** A small floating call window while the user works elsewhere in the app. */
export function CallMini() {
  const s = useStyles();
  const call = useCall((st) => st.call);
  const selfId = useApp((st) => st.identity?.userId);
  if (!call || call.state === 'ringing') return null;
  // The most recent speaker other than us, else anyone.
  const others = call.participants.filter((p) => p.userId !== selfId);
  const focus =
    [...others].sort((a, b) => b.lastSpokeAt - a.lastSpokeAt)[0] ?? call.participants[0];
  const recording = call.participants.some((p) => p.recording);
  return (
    <aside className={s.mini} data-testid="call-mini" aria-label={strings.calls.videoCall}>
      {recording && (
        <div className={s.recording} data-testid="recording-banner">
          ●{' '}
          {strings.inCall.recordingBanner(
            call.participants
              .filter((p) => p.recording)
              .map((p) => p.name)
              .join(', '),
          )}
        </div>
      )}
      {focus && <Tile p={focus} showVideo={videoSenders(call).has(focus.userId)} />}
      <div className={s.miniBar}>
        <Controls compact />
      </div>
    </aside>
  );
}
