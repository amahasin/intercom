import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import {
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
  CallEnd20Filled,
  Chat20Regular,
  ChevronDown16Regular,
  Cursor20Regular,
  Emoji20Regular,
  HandRight20Filled,
  HandRight20Regular,
  Mic20Regular,
  MicOff20Regular,
  MoreHorizontal20Regular,
  Options20Regular,
  People20Regular,
  PersonAdd20Regular,
  PlayCircle20Regular,
  PauseCircle20Regular,
  Record20Regular,
  ShareScreenStart20Regular,
  ShareScreenStop20Regular,
  Video20Regular,
  VideoOff20Regular,
  Whiteboard20Regular,
  Grid20Regular,
} from '@fluentui/react-icons';
import { CALL_REACTIONS } from '@officemesh/protocol';
import { AddPeopleDialog } from './AddPeople.tsx';
import { core, displayName, useApp } from '../state.ts';
import { strings } from '../strings.ts';
import {
  control,
  endForAll,
  hangUp,
  react,
  setBlur,
  setChatOpen,
  setLayout,
  setPeopleOpen,
  startRecording,
  stopRecording,
  stopShare,
  switchDevice,
  toggleCamera,
  toggleHand,
  toggleHold,
  toggleMute,
  useCall,
} from './engine.ts';
import { ScreenPicker } from './ScreenPicker.tsx';
import { requestControl, useRemote } from './remote.ts';
import { setWhiteboardOpen, useWhiteboard } from './whiteboard.ts';

const useStyles = makeStyles({
  bar: {
    flex: 'none',
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalL}`,
    minHeight: '60px',
    background: tokens.colorNeutralBackground1,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    position: 'relative',
    zIndex: 3,
  },
  left: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalM,
    overflow: 'hidden',
  },
  group: { display: 'flex', alignItems: 'center', columnGap: '2px', flex: 'none' },
  divider: {
    width: '1px',
    alignSelf: 'stretch',
    margin: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    background: tokens.colorNeutralStroke2,
  },
  tool: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    rowGap: '2px',
    minWidth: '52px',
    height: '48px',
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalXS}`,
    border: 'none',
    borderRadius: tokens.borderRadiusMedium,
    background: 'transparent',
    color: tokens.colorNeutralForeground1,
    cursor: 'pointer',
    ':hover': { background: tokens.colorSubtleBackgroundHover },
    ':disabled': { color: tokens.colorNeutralForegroundDisabled, cursor: 'default' },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}` },
  },
  pressed: {
    background: tokens.colorSubtleBackgroundSelected,
    color: tokens.colorBrandForeground1,
  },
  label: { fontSize: tokens.fontSizeBase100, lineHeight: tokens.lineHeightBase100 },
  badge: {
    position: 'absolute',
    top: '2px',
    right: '6px',
    fontSize: tokens.fontSizeBase100,
    fontWeight: tokens.fontWeightSemibold,
  },
  chevron: {
    minWidth: '20px',
    width: '20px',
    height: '48px',
    padding: 0,
    marginLeft: '-6px',
  },
  stop: {
    color: tokens.colorPaletteRedForeground1,
    border: `1px solid ${tokens.colorPaletteRedBorder2}`,
  },
  leaveGroup: { display: 'flex', alignItems: 'stretch', columnGap: '1px' },
  leaveMore: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '22px',
    height: '48px',
    border: 'none',
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorPaletteRedBackground3,
    color: '#ffffff',
    cursor: 'pointer',
    ':hover': { background: tokens.colorPaletteRedForeground1 },
  },
  leave: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    rowGap: '2px',
    minWidth: '60px',
    height: '48px',
    border: 'none',
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorPaletteRedBackground3,
    color: '#ffffff',
    cursor: 'pointer',
    ':hover': { background: tokens.colorPaletteRedForeground1 },
  },
  reactions: { display: 'flex', gap: '4px' },
  reactionButton: { fontSize: '22px', minWidth: '40px' },
});

function Tool({
  icon,
  label,
  onClick,
  testId,
  pressed,
  badge,
  disabled,
  extraClass,
}: {
  icon: ReactElement;
  label: string;
  onClick?: () => void;
  testId: string;
  pressed?: boolean;
  badge?: ReactNode;
  disabled?: boolean;
  extraClass?: string;
}) {
  const s = useStyles();
  return (
    <Tooltip content={label} relationship="label">
      <button
        type="button"
        className={mergeClasses(s.tool, pressed && s.pressed, extraClass)}
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        aria-pressed={pressed}
        data-testid={testId}
      >
        {icon}
        <span className={s.label}>{label}</span>
        {badge !== undefined && (
          <span className={s.badge} data-testid={`${testId}-badge`}>
            {badge}
          </span>
        )}
      </button>
    </Tooltip>
  );
}

/** The devices this PC has, refreshed when the menu opens. */
function useDevices(open: boolean) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    if (open) void navigator.mediaDevices.enumerateDevices().then(setDevices);
  }, [open]);
  return devices;
}

function DeviceGroup({
  devices,
  kind,
  setting,
  title,
}: {
  devices: MediaDeviceInfo[];
  kind: MediaDeviceKind;
  setting: 'audioInput' | 'videoInput' | 'audioOutput';
  title: string;
}) {
  const list = devices.filter(
    (d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications',
  );
  return (
    <MenuGroup>
      <MenuGroupHeader>{title}</MenuGroupHeader>
      <MenuItemRadio name={setting} value="" onClick={() => void switchDevice(setting, '')}>
        {strings.calls.systemDefault}
      </MenuItemRadio>
      {list.map((d) => (
        <MenuItemRadio
          key={d.deviceId}
          name={setting}
          value={d.deviceId}
          onClick={() => void switchDevice(setting, d.deviceId)}
        >
          {d.label || d.deviceId.slice(0, 8)}
        </MenuItemRadio>
      ))}
    </MenuGroup>
  );
}

/** Camera or microphone: the button, and beside it a chevron for its devices and options. */
function Split({
  tool,
  children,
  label,
  testId,
}: {
  tool: ReactElement;
  children: (open: boolean) => ReactNode;
  label: string;
  testId: string;
}) {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  return (
    <div className={s.group}>
      {tool}
      <Menu open={open} onOpenChange={(_e, d) => setOpen(d.open)}>
        <MenuTrigger disableButtonEnhancement>
          <Button
            className={s.chevron}
            appearance="subtle"
            icon={<ChevronDown16Regular />}
            aria-label={label}
            data-testid={testId}
          />
        </MenuTrigger>
        <MenuPopover>
          <MenuList>{children(open)}</MenuList>
        </MenuPopover>
      </Menu>
    </div>
  );
}

function MicMenu({ open }: { open: boolean }) {
  const settings = useApp((st) => st.settings);
  const devices = useDevices(open);
  return (
    <>
      <Menu
        checkedValues={{
          audioInput: [settings?.audioInput ?? ''],
          audioOutput: [settings?.audioOutput ?? ''],
        }}
      >
        <MenuTrigger disableButtonEnhancement>
          <MenuItem>{strings.calls.microphone}</MenuItem>
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            <DeviceGroup
              devices={devices}
              kind="audioinput"
              setting="audioInput"
              title={strings.calls.microphone}
            />
            <MenuDivider />
            <DeviceGroup
              devices={devices}
              kind="audiooutput"
              setting="audioOutput"
              title={strings.calls.speaker}
            />
          </MenuList>
        </MenuPopover>
      </Menu>
      <Menu checkedValues={{ noise: [settings?.noiseSuppression ?? 'high'] }}>
        <MenuTrigger disableButtonEnhancement>
          <MenuItem>{strings.calls.noise.label}</MenuItem>
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            {(['high', 'standard', 'off'] as const).map((level) => (
              <MenuItemRadio
                key={level}
                name="noise"
                value={level}
                onClick={async () => {
                  // The engine reopens the microphone when the setting changes.
                  useApp.setState({
                    settings: await core.invoke('settings.set', { noiseSuppression: level }),
                  });
                }}
                data-testid={`noise-${level}`}
              >
                {strings.calls.noise[level]}
              </MenuItemRadio>
            ))}
          </MenuList>
        </MenuPopover>
      </Menu>
    </>
  );
}

function CameraMenu({ open, blurDisabled }: { open: boolean; blurDisabled: boolean }) {
  const settings = useApp((st) => st.settings);
  const blur = useCall((st) => st.blur);
  const devices = useDevices(open);
  return (
    <Menu checkedValues={{ videoInput: [settings?.videoInput ?? ''] }}>
      <MenuTrigger disableButtonEnhancement>
        <MenuItem>{strings.calls.camera}</MenuItem>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          <DeviceGroup
            devices={devices}
            kind="videoinput"
            setting="videoInput"
            title={strings.calls.camera}
          />
          <MenuDivider />
          <MenuItem
            onClick={() => void setBlur(!blur)}
            disabled={blurDisabled}
            data-testid="call-blur-quick"
          >
            {blur ? strings.inCall.blurOff : strings.inCall.blurOn}
          </MenuItem>
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}

/**
 * The call's controls, along the top of the call window: chat and people, raise a hand, react,
 * the view, more, then camera, microphone and share, and Leave. `left` is what sits at the far
 * left (the timer and who is in the call).
 */
export function CallToolbar({ left }: { left: ReactNode }) {
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
  const peopleOpen = useCall((st) => st.peopleOpen);
  const remotes = useCall((st) => st.remotes);
  const board = useWhiteboard((st) => st.open);
  const phase = useRemote((st) => st.phase);
  const hand = call.participants.find((p) => p.userId === selfId)?.hand === true;
  const hands = call.participants.filter((p) => p.hand).length;
  const organizer = call.organizer === selfId;
  const video = call.media === 'video';
  const [picking, setPicking] = useState(false);
  const [adding, setAdding] = useState(false);
  const [asking, setAsking] = useState(false);
  const [ending, setEnding] = useState(false);
  // Only the organiser can end a call that has more than two people for everyone; with two,
  // leaving is ending.
  const canEndForAll = organizer && call.participants.length > 2;
  // Someone else is sharing a whole screen to this user, in a call that connects directly.
  const sharer = call.participants.find(
    (p) => p.userId !== selfId && p.sharing && !!remotes[p.userId]?.screen,
  );
  const canTakeControl = sharer !== undefined && !call.relay && phase === 'idle';

  return (
    <div
      className={s.bar}
      role="toolbar"
      aria-label={strings.inCall.controls}
      data-testid="call-toolbar"
    >
      <div className={s.left}>{left}</div>

      <div className={s.group}>
        {canTakeControl && (
          <Tool
            icon={<Cursor20Regular />}
            label={strings.remote.takeControl}
            onClick={() => setAsking(true)}
            testId="rc-request"
          />
        )}
        {(call.convId || call.chat) && (
          <Tool
            icon={<Chat20Regular />}
            label={strings.inCall.chat}
            pressed={chatOpen}
            onClick={() => setChatOpen(!chatOpen)}
            testId="call-chat"
          />
        )}
        <Tool
          icon={<People20Regular />}
          label={strings.inCall.people}
          pressed={peopleOpen}
          badge={call.participants.length}
          onClick={() => setPeopleOpen(!peopleOpen)}
          testId="call-people"
        />
        <Tool
          icon={hand ? <HandRight20Filled /> : <HandRight20Regular />}
          label={hand ? strings.inCall.lowerHand : strings.inCall.raiseHand}
          pressed={hand}
          badge={hands > 0 ? hands : undefined}
          onClick={toggleHand}
          testId="call-hand"
        />
        <Popover positioning="below" withArrow>
          <PopoverTrigger disableButtonEnhancement>
            <button
              type="button"
              className={s.tool}
              aria-label={strings.inCall.react}
              data-testid="call-react"
            >
              <Emoji20Regular />
              <span className={s.label}>{strings.inCall.react}</span>
            </button>
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
        <Menu>
          <MenuTrigger disableButtonEnhancement>
            <button
              type="button"
              className={s.tool}
              aria-label={strings.inCall.view}
              data-testid="call-layout"
            >
              <Grid20Regular />
              <span className={s.label}>{strings.inCall.view}</span>
            </button>
          </MenuTrigger>
          <MenuPopover>
            <MenuList checkedValues={{ layout: [layout] }}>
              <MenuItemRadio
                name="layout"
                value="gallery"
                onClick={() => setLayout('gallery')}
                data-testid="layout-gallery"
              >
                {strings.inCall.gallery}
              </MenuItemRadio>
              <MenuItemRadio
                name="layout"
                value="speaker"
                onClick={() => setLayout('speaker')}
                data-testid="layout-speaker"
              >
                {strings.inCall.speaker}
              </MenuItemRadio>
            </MenuList>
          </MenuPopover>
        </Menu>
        <Tool
          icon={<Whiteboard20Regular />}
          label={strings.inCall.whiteboard}
          pressed={board}
          onClick={() => setWhiteboardOpen(!board)}
          testId="call-whiteboard"
        />
        <Menu>
          <MenuTrigger disableButtonEnhancement>
            <button
              type="button"
              className={s.tool}
              aria-label={strings.inCall.more}
              data-testid="call-more"
            >
              <MoreHorizontal20Regular />
              <span className={s.label}>{strings.inCall.more}</span>
            </button>
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              {video && (
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
                <MenuItem
                  icon={<Options20Regular />}
                  onClick={() => control('mute', null)}
                  data-testid="call-mute-all"
                >
                  {strings.inCall.muteAll}
                </MenuItem>
              )}
            </MenuList>
          </MenuPopover>
        </Menu>
      </div>

      <span className={s.divider} />

      <div className={s.group}>
        {video && (
          <Split
            label={strings.calls.camera}
            testId="call-camera-menu"
            tool={
              <Tool
                icon={camera ? <Video20Regular /> : <VideoOff20Regular />}
                label={strings.calls.camera}
                pressed={camera}
                onClick={() => void toggleCamera()}
                testId="call-camera"
              />
            }
          >
            {(open) => <CameraMenu open={open} blurDisabled={!camera} />}
          </Split>
        )}
        <Split
          label={strings.calls.microphone}
          testId="call-mic-menu"
          tool={
            <Tool
              icon={muted ? <MicOff20Regular /> : <Mic20Regular />}
              label={muted ? strings.calls.unmute : strings.calls.mute}
              pressed={muted}
              onClick={toggleMute}
              testId="call-mute"
            />
          }
        >
          {(open) => <MicMenu open={open} />}
        </Split>
        <Tool
          icon={sharing ? <ShareScreenStop20Regular /> : <ShareScreenStart20Regular />}
          label={sharing ? strings.calls.stopShare : strings.calls.share}
          onClick={() => (sharing ? void stopShare() : setPicking(true))}
          testId="call-share"
          pressed={sharing}
          extraClass={sharing ? s.stop : undefined}
        />
      </div>

      <span className={s.divider} />

      <div className={s.leaveGroup}>
        <Tooltip content={strings.calls.hangUp} relationship="label">
          <button
            type="button"
            className={s.leave}
            onClick={hangUp}
            aria-label={strings.calls.hangUp}
            data-testid="call-hangup"
          >
            <CallEnd20Filled />
            <span className={s.label}>{strings.calls.hangUp}</span>
          </button>
        </Tooltip>
        {canEndForAll && (
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <button
                type="button"
                className={s.leaveMore}
                aria-label={strings.calls.leaveOptions}
                data-testid="call-leave-menu"
              >
                <ChevronDown16Regular />
              </button>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem
                  icon={<CallEnd20Filled />}
                  onClick={() => setEnding(true)}
                  data-testid="call-end-all"
                >
                  {strings.calls.endForAll}
                </MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
        )}
      </div>
      {ending && (
        <Dialog open onOpenChange={(_e, d) => !d.open && setEnding(false)}>
          <DialogSurface data-testid="call-end-all-dialog">
            <DialogBody>
              <DialogTitle>{strings.calls.endForAllTitle}</DialogTitle>
              <DialogContent>
                <Text block>{strings.calls.endForAllBody}</Text>
              </DialogContent>
              <DialogActions>
                <Button onClick={() => setEnding(false)} data-testid="call-end-all-cancel">
                  {strings.calls.endForAllCancel}
                </Button>
                <Button
                  appearance="primary"
                  onClick={() => {
                    setEnding(false);
                    endForAll();
                  }}
                  data-testid="call-end-all-confirm"
                >
                  {strings.calls.endForAllConfirm}
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      )}

      {picking && <ScreenPicker onClose={() => setPicking(false)} />}
      {asking && sharer && (
        <Dialog open onOpenChange={(_e, d) => !d.open && setAsking(false)}>
          <DialogSurface data-testid="rc-confirm-dialog">
            <DialogBody>
              <DialogTitle>{strings.remote.requestTitle}</DialogTitle>
              <DialogContent>
                <Text block>{strings.remote.requestBody(displayName(sharer.userId))}</Text>
              </DialogContent>
              <DialogActions>
                <Button onClick={() => setAsking(false)} data-testid="rc-confirm-cancel">
                  {strings.remote.cancel}
                </Button>
                <Button
                  appearance="primary"
                  onClick={() => {
                    setAsking(false);
                    requestControl(sharer.userId);
                  }}
                  data-testid="rc-confirm"
                >
                  {strings.remote.requestButton}
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      )}
      {adding && <AddPeopleDialog onClose={() => setAdding(false)} />}
    </div>
  );
}
