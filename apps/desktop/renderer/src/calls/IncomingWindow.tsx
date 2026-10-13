import { useEffect, useRef, useState } from 'react';
import {
  Avatar,
  Button,
  makeStyles,
  mergeClasses,
  Switch,
  Text,
  tokens,
  Tooltip,
} from '@fluentui/react-components';
import {
  Call24Filled,
  CallEnd24Filled,
  CallPause24Regular,
  PersonAdd24Regular,
  Video24Filled,
} from '@fluentui/react-icons';
import { Logo } from '../shell/Logo.tsx';
import { avatarSrc, displayName, useApp } from '../state.ts';
import { strings } from '../strings.ts';
import { CallEndedCard } from './CallEnded.tsx';
import { acceptCall, declineCall, mergeCall, useCall } from './engine.ts';

const useStyles = makeStyles({
  frame: {
    boxSizing: 'border-box',
    padding: '1px',
    borderRadius: tokens.borderRadiusXLarge,
    background: tokens.colorNeutralStroke1,
    overflow: 'hidden',
  },
  card: {
    borderRadius: tokens.borderRadiusXLarge,
    background: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalS,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL} ${tokens.spacingVerticalL}`,
    // The whole card drags the window; the buttons do not.
    WebkitAppRegion: 'drag',
  },
  header: { display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalS },
  app: { color: tokens.colorNeutralForeground3, flex: 1, minWidth: 0 },
  who: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    rowGap: '2px',
    textAlign: 'center',
    padding: `${tokens.spacingVerticalS} 0`,
  },
  buttons: {
    display: 'flex',
    justifyContent: 'center',
    columnGap: tokens.spacingHorizontalM,
    WebkitAppRegion: 'no-drag',
  },
  round: {
    width: '84px',
    height: '40px',
    borderRadius: tokens.borderRadiusLarge,
    color: '#fff',
  },
  accept: { background: '#107c10', ':hover': { background: '#0e6b0e', color: '#fff' } },
  decline: {
    background: tokens.colorPaletteRedBackground3,
    ':hover': { background: tokens.colorPaletteRedForeground1, color: '#fff' },
  },
  busy: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalXS,
    WebkitAppRegion: 'no-drag',
  },
  option: { justifyContent: 'flex-start' },
  note: { color: tokens.colorNeutralForeground3 },
});

/**
 * The small window that rings for an incoming call: bottom-right of the screen, above
 * everything else, apart from the main window. If the user is already in a call, it offers
 * what to do about it: hold that call and answer, end it and answer, add the caller to it,
 * or decline.
 */
export function IncomingWindow() {
  const s = useStyles();
  const call = useCall((st) => st.call);
  const all = useCall((st) => st.all);
  const ending = useCall((st) => st.ending);
  const caller = useApp((st) => (call ? st.people[call.caller] : undefined));
  const [camera, setCamera] = useState(true);
  const root = useRef<HTMLDivElement>(null);

  // The window is as tall as what it shows (the options change with the situation).
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const fit = () => window.officemeshWindow?.fit(Math.ceil(el.getBoundingClientRect().height));
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    fit();
    return () => observer.disconnect();
  }, []);

  // After "Call missed" has been shown for a moment, the window goes away.
  const hadEnding = useRef(false);
  useEffect(() => {
    if (ending) hadEnding.current = true;
    else if (hadEnding.current) window.officemeshWindow?.close();
  }, [ending]);

  if (ending) {
    return (
      <div className={s.frame} ref={root}>
        <CallEndedCard />
      </div>
    );
  }
  if (!call) return <div ref={root} />;
  const name = displayName(call.caller);
  // The call this user is in, if any: the one that is not on hold.
  const current = all.find((c) => c.callId !== call.callId && c.state !== 'ringing' && !c.held);
  const waiting = call.waiting === true && current !== undefined;
  const video = call.media === 'video';
  const group = call.participants.length > 2;
  return (
    <div className={s.frame} ref={root}>
      <div
        className={s.card}
        role="alertdialog"
        aria-label={strings.calls.isCalling(name)}
        data-testid="incoming-call"
        data-waiting={waiting ? 'true' : 'false'}
      >
        <div className={s.header}>
          <Logo size={18} />
          <Text size={200} className={s.app} truncate wrap={false}>
            {strings.appName}
            {group ? ` - ${strings.calls.people(call.participants.length)}` : ''}
          </Text>
        </div>
        <div className={s.who}>
          <Avatar name={name} size={72} color="colorful" image={avatarSrc(caller?.avatarHash)} />
          <Text weight="semibold" size={400} style={{ marginTop: tokens.spacingVerticalS }}>
            {name}
          </Text>
          <Text size={300}>
            {waiting
              ? strings.incoming.waiting(
                  video ? strings.incoming.videoCall : strings.incoming.audioCall,
                )
              : strings.calls.isCallingYou(video)}
          </Text>
        </div>
        {waiting ? (
          <div className={s.busy}>
            <Text size={200} className={s.note} data-testid="incoming-current">
              {strings.incoming.youAreIn(callName(current))}
            </Text>
            {video && (
              <Switch
                checked={camera}
                onChange={(_e, d) => setCamera(d.checked)}
                label={strings.incoming.useCamera}
                data-testid="incoming-camera"
              />
            )}
            <Tooltip
              content={current.relay ? strings.incoming.cannotHold : strings.incoming.holdHelp}
              relationship="description"
            >
              <Button
                appearance="primary"
                icon={<CallPause24Regular />}
                className={s.option}
                disabled={current.relay !== undefined}
                onClick={() => void acceptCall(video && camera, 'hold')}
                data-testid="call-accept-hold"
              >
                {strings.incoming.holdAndAccept}
              </Button>
            </Tooltip>
            <Button
              icon={<CallEnd24Filled />}
              className={s.option}
              onClick={() => void acceptCall(video && camera, 'end')}
              data-testid="call-accept-end"
            >
              {strings.incoming.endAndAccept}
            </Button>
            <Button
              icon={<PersonAdd24Regular />}
              className={s.option}
              disabled={current.relay === undefined && current.participants.length >= 8}
              onClick={() => void mergeCall()}
              data-testid="call-merge"
            >
              {strings.incoming.addToCall}
            </Button>
            <Button
              icon={<CallEnd24Filled />}
              className={mergeClasses(s.option)}
              onClick={declineCall}
              data-testid="call-decline"
            >
              {strings.calls.decline}
            </Button>
          </div>
        ) : (
          <div className={s.buttons}>
            {video && (
              <Tooltip content={strings.calls.acceptVideo} relationship="label">
                <Button
                  className={mergeClasses(s.round, s.accept)}
                  icon={<Video24Filled />}
                  aria-label={strings.calls.acceptVideo}
                  onClick={() => void acceptCall(true)}
                  data-testid="call-accept-video"
                />
              </Tooltip>
            )}
            <Tooltip content={strings.calls.accept} relationship="label">
              <Button
                className={mergeClasses(s.round, s.accept)}
                icon={<Call24Filled />}
                aria-label={strings.calls.accept}
                onClick={() => void acceptCall(false)}
                data-testid="call-accept-audio"
              />
            </Tooltip>
            <Tooltip content={strings.calls.decline} relationship="label">
              <Button
                className={mergeClasses(s.round, s.decline)}
                icon={<CallEnd24Filled />}
                aria-label={strings.calls.decline}
                onClick={declineCall}
                data-testid="call-decline"
              />
            </Tooltip>
          </div>
        )}
      </div>
    </div>
  );
}

/** What to call the call somebody is in: the people in it, or its chat. */
function callName(call: { convId?: string | undefined; participants: Array<{ userId: string }> }) {
  const st = useApp.getState();
  const title = call.convId ? st.conversations[call.convId]?.title : undefined;
  if (title) return title;
  const me = st.identity?.userId;
  const others = call.participants.filter((p) => p.userId !== me).map((p) => displayName(p.userId));
  return others.join(', ') || strings.calls.people(call.participants.length);
}
