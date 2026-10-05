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
  mergeClasses,
  Text,
  tokens,
  Tooltip,
} from '@fluentui/react-components';
import {
  ArrowMaximize20Regular,
  ArrowMinimize20Regular,
  CallEnd20Filled,
  Mic20Regular,
  MicOff20Regular,
  PersonAdd20Regular,
  ShareScreenStart20Regular,
  ShareScreenStop20Regular,
  PauseCircle20Regular,
  PlayCircle20Regular,
  Video20Regular,
  VideoOff20Regular,
} from '@fluentui/react-icons';
import type { CallParticipantView } from '@officemesh/protocol/ipc';
import { PeoplePicker } from '../people/PeoplePicker.tsx';
import { avatarSrc, useApp } from '../state.ts';
import { strings } from '../strings.ts';
import {
  hangUp,
  inviteToCall,
  setCallView,
  stopShare,
  toggleCamera,
  toggleHold,
  toggleMute,
  useCall,
  videoSenders,
} from './engine.ts';
import { ScreenPicker } from './ScreenPicker.tsx';

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
  },
  bar: {
    display: 'flex',
    justifyContent: 'center',
    columnGap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalM,
  },
  control: { minWidth: '44px' },
  banner: { textAlign: 'center', padding: tokens.spacingVerticalXS, background: '#605e5c' },
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

function Tile({ p, showVideo }: { p: CallParticipantView; showVideo: boolean }) {
  const s = useStyles();
  const selfId = useApp((st) => st.identity?.userId);
  const self = p.userId === selfId;
  const remote = useCall((st) => st.remotes[p.userId]);
  const local = useCall((st) => st.local);
  const camera = useCall((st) => st.camera);
  const speaking = useCall((st) =>
    self ? st.speaking : (st.remotes[p.userId]?.speaking ?? false),
  );
  const stream = self ? (camera ? local : undefined) : remote?.camera;
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
    >
      {hasVideo ? (
        <MediaVideo stream={stream} mirror={self} className={s.video} />
      ) : (
        <Avatar name={p.name} size={72} color="colorful" image={avatarSrc(p.avatarHash)} />
      )}
      <span className={s.label}>
        {self ? strings.calls.you : p.name}
        {p.muted ? ` · ${strings.calls.muted}` : ''}
        {p.onHold ? ` · ${strings.calls.onHold}` : ''}
        {connecting ? ` · ${strings.calls.connecting}` : ''}
      </span>
    </div>
  );
}

function Controls({ compact }: { compact?: boolean }) {
  const s = useStyles();
  const call = useCall((st) => st.call)!;
  const muted = useCall((st) => st.muted);
  const camera = useCall((st) => st.camera);
  const sharing = useCall((st) => st.sharing);
  const onHold = useCall((st) => st.onHold);
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
          onHold ? strings.calls.resume : strings.calls.hold,
          onHold ? <PlayCircle20Regular /> : <PauseCircle20Regular />,
          toggleHold,
          'call-hold',
          { 'aria-pressed': onHold },
        )}
      {!compact &&
        button(strings.calls.addPeople, <PersonAdd20Regular />, () => setAdding(true), 'call-add')}
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

export function CallStage() {
  const s = useStyles();
  const call = useCall((st) => st.call);
  const onHold = useCall((st) => st.onHold);
  const error = useCall((st) => st.error);
  const duration = useDuration(call?.answeredAt);
  const { sharer, stream, self } = useSharer();
  if (!call || call.state === 'ringing') return null;
  const senders = videoSenders(call);
  const people = call.participants;
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
        {error && <Text size={200}>{error}</Text>}
      </div>
      {onHold && <div className={s.banner}>{strings.calls.youAreOnHold}</div>}
      {sharer && (
        <div className={s.banner} data-testid="share-banner">
          {self ? strings.calls.youAreSharing : strings.calls.sharing(sharer.name)}
        </div>
      )}
      <div className={s.body}>
        {stream && (
          <div className={s.shared} data-testid="shared-screen">
            <MediaVideo stream={stream} className={s.screenVideo} />
          </div>
        )}
        <div
          className={stream ? s.strip : s.grid}
          style={stream ? undefined : { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {people.map((p) => (
            <Tile key={p.userId} p={p} showVideo={senders.has(p.userId)} />
          ))}
        </div>
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
  return (
    <aside className={s.mini} data-testid="call-mini" aria-label={strings.calls.videoCall}>
      {focus && <Tile p={focus} showVideo={videoSenders(call).has(focus.userId)} />}
      <div className={s.miniBar}>
        <Controls compact />
      </div>
    </aside>
  );
}
