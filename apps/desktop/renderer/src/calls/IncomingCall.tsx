import { useEffect } from 'react';
import {
  Avatar,
  Button,
  makeStyles,
  MessageBar,
  MessageBarBody,
  Text,
  tokens,
} from '@fluentui/react-components';
import { Call20Filled, CallEnd20Filled, Video20Filled } from '@fluentui/react-icons';
import { avatarSrc, displayName, useApp } from '../state.ts';
import { strings } from '../strings.ts';
import { acceptCall, declineCall, useCall } from './engine.ts';

const useStyles = makeStyles({
  card: {
    position: 'fixed',
    top: '64px',
    right: '20px',
    width: '340px',
    zIndex: 1100,
    padding: tokens.spacingHorizontalL,
    borderRadius: tokens.borderRadiusXLarge,
    background: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow28,
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalM,
  },
  who: { display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalM },
  buttons: { display: 'flex', columnGap: tokens.spacingHorizontalS, justifyContent: 'flex-end' },
  notice: { position: 'fixed', top: '64px', right: '20px', width: '360px', zIndex: 1100 },
});

/** A two-tone ring made on the fly (no audio files), repeating while the call rings. */
function useRingTone(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const ctx = new AudioContext();
    const ring = () => {
      const t = ctx.currentTime;
      for (const [freq, start] of [
        [440, 0],
        [480, 0],
        [440, 0.6],
        [480, 0.6],
      ] as const) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.06, t + start);
        gain.gain.setValueAtTime(0, t + start + 0.4);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t + start);
        osc.stop(t + start + 0.45);
      }
    };
    ring();
    const timer = window.setInterval(ring, 3_000);
    return () => {
      window.clearInterval(timer);
      void ctx.close();
    };
  }, [active]);
}

/** The in-app ring for an incoming call, and the reason an outgoing call did not connect. */
export function IncomingCall() {
  const s = useStyles();
  const call = useCall((st) => st.call);
  const notice = useCall((st) => st.notice);
  const caller = useApp((st) => (call ? st.people[call.caller] : undefined));
  const ringing = call?.state === 'ringing';
  useRingTone(ringing);
  if (ringing && call) {
    const name = displayName(call.caller);
    return (
      <div
        className={s.card}
        role="alertdialog"
        aria-label={strings.calls.isCalling(name)}
        data-testid="incoming-call"
      >
        <div className={s.who}>
          <Avatar name={name} size={48} color="colorful" image={avatarSrc(caller?.avatarHash)} />
          <div>
            <Text weight="semibold" block>
              {name}
            </Text>
            <Text size={200}>
              {call.media === 'video' ? strings.calls.incomingVideo : strings.calls.incomingAudio}
              {call.participants.length > 1
                ? ` · ${strings.calls.people(call.participants.length)}`
                : ''}
            </Text>
          </div>
        </div>
        <div className={s.buttons}>
          <Button
            icon={<CallEnd20Filled />}
            onClick={declineCall}
            data-testid="call-decline"
            style={{ background: tokens.colorPaletteRedBackground3, color: '#fff' }}
          >
            {strings.calls.decline}
          </Button>
          <Button
            icon={<Call20Filled />}
            onClick={() => void acceptCall(false)}
            data-testid="call-accept-audio"
          >
            {strings.calls.accept}
          </Button>
          {call.media === 'video' && (
            <Button
              appearance="primary"
              icon={<Video20Filled />}
              onClick={() => void acceptCall(true)}
              data-testid="call-accept-video"
            >
              {strings.calls.acceptVideo}
            </Button>
          )}
        </div>
      </div>
    );
  }
  if (notice && notice.declines.length > 0) {
    const first = notice.declines[0]!;
    const reason =
      first.reason === 'timeout'
        ? 'no-answer'
        : first.reason === 'full'
          ? 'declined'
          : first.reason;
    return (
      <div className={s.notice}>
        <MessageBar intent="warning" data-testid="call-notice" data-reason={first.reason}>
          <MessageBarBody>{strings.calls.ended[reason](displayName(first.userId))}</MessageBarBody>
        </MessageBar>
      </div>
    );
  }
  return null;
}
