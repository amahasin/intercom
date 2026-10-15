/**
 * Remote help (M6.18): the "Remote help" menu of a 1:1 chat, and the banner at the top of the
 * main window that follows a session (asked, waiting, open, ended) wherever the user is.
 * The screen sharing itself is in the helper's own windows: a viewer for the person looking, and
 * on the shared desktop only a thin red frame and a notification-area icon. What the person
 * sharing can do (stop control, end) is also here, in the banner.
 */
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import {
  Button,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  makeStyles,
  tokens,
  type ButtonProps,
} from '@fluentui/react-components';
import {
  Call20Regular,
  ChevronDown16Regular,
  DesktopCursor20Regular,
  PersonSupport20Regular,
} from '@fluentui/react-icons';
import type { AssistKind } from '@officemesh/protocol';
import type { AssistView } from '@officemesh/protocol/ipc';
import { startCall, useCall } from '../calls/engine.ts';
import { core, displayName, useApp } from '../state.ts';
import { strings } from '../strings.ts';
import { useExpired } from '../shell/ephemeral.ts';

interface AssistState {
  sessions: AssistView[];
  /** A request that could not be made (shown in the banner). */
  error: { text: string; settings: boolean } | undefined;
}

export const useAssist = create<AssistState>(() => ({ sessions: [], error: undefined }));

let started = false;
/** Follow the core's remote help sessions (every window; the main one shows them). */
export function initAssist(): void {
  if (started) return;
  started = true;
  core.on('assist.changed', (sessions) => useAssist.setState({ sessions }));
  void core
    .invoke('assist.list', {})
    .then((sessions) => useAssist.setState({ sessions }))
    .catch(() => {});
}

const message = (err: unknown) =>
  err instanceof Error ? err.message.replace(/^.*?: /, '') : String(err);

async function failed(err: unknown): Promise<void> {
  const status = await core.invoke('assist.status', {}).catch(() => undefined);
  useAssist.setState({
    error: { text: message(err), settings: status !== undefined && !status.allowed },
  });
}

async function ask(userId: string, kind: AssistKind): Promise<void> {
  useAssist.setState({ error: undefined });
  try {
    await core.invoke('assist.request', { userId, kind });
  } catch (err) {
    await failed(err);
  }
}

const useMenuStyles = makeStyles({
  /** A choice and, under it, what it does: two rows, not two columns. */
  twoRows: { display: 'flex', flexDirection: 'column', rowGap: '2px' },
  hint: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
});

/** The Remote help button of a 1:1 chat (or of a colleague's page): ask for help, or connect. */
export function RemoteHelpButton({
  peer,
  appearance = 'subtle',
  disabled = false,
}: {
  peer: string;
  appearance?: ButtonProps['appearance'];
  disabled?: boolean;
}) {
  const m = useMenuStyles();
  const busy = useAssist((s) => s.sessions.some((x) => x.state !== 'ended'));
  const name = displayName(peer);
  const choice = (title: string, hint: string) => (
    <span className={m.twoRows}>
      <span>{title}</span>
      <span className={m.hint}>{hint}</span>
    </span>
  );
  return (
    <Menu positioning="below-end">
      <MenuTrigger disableButtonEnhancement>
        <Button
          appearance={appearance}
          icon={<DesktopCursor20Regular />}
          disabled={busy || disabled}
          title={busy ? strings.assist.busy : undefined}
          data-testid="assist-menu"
        >
          {strings.assist.button}
          <ChevronDown16Regular />
        </Button>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          <MenuItem
            icon={<PersonSupport20Regular />}
            onClick={() => void ask(peer, 'help-me')}
            data-testid="assist-help-me"
          >
            {choice(strings.assist.helpMe(name), strings.assist.helpMeHint)}
          </MenuItem>
          <MenuItem
            icon={<DesktopCursor20Regular />}
            onClick={() => void ask(peer, 'let-me-in')}
            data-testid="assist-let-me-in"
          >
            {choice(strings.assist.letMeIn(name), strings.assist.letMeInHint)}
          </MenuItem>
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}

const useStyles = makeStyles({
  banners: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalXS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM} 0`,
  },
});

/** One banner per session that is going on or has just ended, and one for a failed request. */
export function RemoteHelpBanners() {
  const s = useStyles();
  const sessions = useAssist((st) => st.sessions);
  const error = useAssist((st) => st.error);
  // "Call" in the remote help window (or its notification-area menu): ring that colleague. This
  // window runs the calls, and only the main one shows these banners.
  useEffect(
    () =>
      core.on('assist.call', ({ userId }) => {
        if (useCall.getState().call !== null) return;
        void startCall([userId], 'audio').catch(() => {});
      }),
    [],
  );
  // A failed request that only says what went wrong goes after a few seconds; one with something
  // to do (open Windows' settings) stays until it is dealt with.
  const errorGone = useExpired(error && !error.settings ? error.text : undefined);
  const shownError = error && !errorGone ? error : undefined;
  if (sessions.length === 0 && !shownError) return null;
  return (
    <div className={s.banners}>
      {shownError && (
        <MessageBar intent="error" data-testid="assist-error">
          <MessageBarBody>
            {shownError.text}
            {shownError.settings && ` ${strings.assist.turnedOffHelp}`}
          </MessageBarBody>
          <MessageBarActions
            containerAction={
              <Button
                appearance="transparent"
                size="small"
                onClick={() => useAssist.setState({ error: undefined })}
              >
                {strings.assist.dismiss}
              </Button>
            }
          >
            {shownError.settings && (
              <Button onClick={() => void core.invoke('assist.openSettings', {})}>
                {strings.assist.openSettings}
              </Button>
            )}
          </MessageBarActions>
        </MessageBar>
      )}
      {sessions.map((x) => (
        <SessionBanner key={x.sessionId} session={x} />
      ))}
    </div>
  );
}

function SessionBanner({ session: x }: { session: AssistView }) {
  const [working, setWorking] = useState(false);
  const name = displayName(x.peer);
  const newDevice = useApp((st) => st.people[x.peer]?.trust === 'new-device');
  const inCall = useCall((st) => st.call !== null);
  // How a session ended is for information: it goes after a few seconds (a session that is still
  // going, or waiting for an answer, stays).
  const endedGone = useExpired(x.state === 'ended' ? x.sessionId : undefined);
  const run = (change: () => Promise<unknown>) => async () => {
    setWorking(true);
    useAssist.setState({ error: undefined });
    try {
      await change();
    } catch (err) {
      await failed(err);
    } finally {
      setWorking(false);
    }
  };
  const button = (
    label: string,
    command: 'assist.accept' | 'assist.decline' | 'assist.end',
    primary = false,
  ) => (
    <Button
      appearance={primary ? 'primary' : 'secondary'}
      disabled={working}
      onClick={() => void run(() => core.invoke(command, { sessionId: x.sessionId }))()}
      data-testid={`assist-${command.slice(7)}`}
    >
      {label}
    </Button>
  );
  /** The sharing side's switch: let the colleague control this PC, or only look. */
  const controlButton = (on: boolean) => (
    <Button
      disabled={working}
      onClick={() =>
        void run(() => core.invoke('assist.control', { sessionId: x.sessionId, on }))()
      }
      data-testid="assist-control"
      data-on={!on}
    >
      {on ? strings.assist.allowControl : strings.assist.stopControl}
    </Button>
  );
  /** Talk it through while it goes on: an audio call to the same colleague. */
  const callButton = (
    <Button
      icon={<Call20Regular />}
      disabled={inCall}
      onClick={() => void startCall([x.peer], 'audio')}
      data-testid="assist-call"
    >
      {strings.assist.call}
    </Button>
  );
  let intent: 'info' | 'warning' | 'success' | 'error' = 'info';
  let title: string | undefined;
  let body: string;
  let actions: React.ReactNode = null;
  switch (x.state) {
    case 'asking':
      body = strings.assist.asking[x.kind](name);
      actions = button(strings.assist.cancel, 'assist.end');
      break;
    case 'asked':
      intent = 'warning';
      title = strings.assist.askedTitle[x.kind](name);
      body = strings.assist.askedBody[x.kind];
      if (newDevice) body += ` ${strings.assist.newDevice(name)}`;
      actions = (
        <>
          {button(
            x.kind === 'help-me' ? strings.assist.connect : strings.assist.allow,
            'assist.accept',
            true,
          )}
          {button(strings.assist.decline, 'assist.decline')}
        </>
      );
      break;
    case 'starting':
      body =
        x.role === 'sharer' ? strings.assist.starting.sharer : strings.assist.starting.viewer(name);
      actions = button(strings.assist.cancel, 'assist.end');
      break;
    case 'open':
      intent = 'success';
      if (x.role === 'viewer') {
        body = strings.assist.open.viewer(name);
        actions = (
          <>
            {callButton}
            {button(strings.assist.end, 'assist.end')}
          </>
        );
      } else {
        body =
          x.control === undefined
            ? strings.assist.open.waiting(name)
            : x.control
              ? strings.assist.open.controlling(name)
              : strings.assist.open.viewing(name);
        actions = (
          <>
            {callButton}
            {x.control !== undefined && controlButton(!x.control)}
            {button(strings.assist.end, 'assist.end')}
          </>
        );
      }
      break;
    case 'ended': {
      const reason = x.endReason ?? 'closed';
      intent =
        reason === 'failed' || reason === 'lost' || reason === 'no-connection' ? 'error' : 'info';
      body = strings.assist.ended[reason](name, x.endedBy === 'me');
      break;
    }
  }
  if (endedGone) return null;
  return (
    <MessageBar
      intent={intent}
      layout="multiline"
      data-testid="assist-banner"
      data-state={x.state}
      data-role={x.role}
      data-reason={x.endReason}
    >
      <MessageBarBody>
        {title && <MessageBarTitle>{title}</MessageBarTitle>}
        {body}
      </MessageBarBody>
      <MessageBarActions
        containerAction={
          x.state === 'ended' ? (
            <Button
              appearance="transparent"
              size="small"
              onClick={() => void core.invoke('assist.dismiss', { sessionId: x.sessionId })}
              data-testid="assist-dismiss"
            >
              {strings.assist.dismiss}
            </Button>
          ) : undefined
        }
      >
        {actions}
      </MessageBarActions>
    </MessageBar>
  );
}
