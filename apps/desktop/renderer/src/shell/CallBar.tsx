import { useEffect, useState } from 'react';
import { Button, makeStyles, Text, tokens } from '@fluentui/react-components';
import { Call16Filled, CallEnd16Filled, Open16Regular } from '@fluentui/react-icons';
import type { CallView } from '@officemesh/protocol/ipc';
import { core, useApp } from '../state.ts';
import { strings } from '../strings.ts';
import { useCall } from '../calls/engine.ts';

const useStyles = makeStyles({
  bar: {
    flex: 'none',
    display: 'flex',
    flexDirection: 'column',
    background: tokens.colorPaletteGreenBackground3,
    color: '#ffffff',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalL}`,
  },
  held: { background: tokens.colorNeutralBackground5, color: tokens.colorNeutralForeground1 },
  grow: { flex: 1, minWidth: 0 },
  action: { color: 'inherit' },
});

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

/** What to call a call: its chat's title, or the people in it. */
function nameOf(call: CallView, selfId: string | undefined): string {
  const title = call.convId ? useApp.getState().conversations[call.convId]?.title : undefined;
  if (title) return title;
  const others = call.participants.filter((p) => p.userId !== selfId).map((p) => p.name);
  return others.join(', ') || strings.calls.people(call.participants.length);
}

/**
 * The main window's view of the calls: each call has a window of its own, so this is only a
 * reminder with a way back to it (and a way out). The user keeps chatting here meanwhile.
 */
export function CallBar() {
  const s = useStyles();
  const all = useCall((st) => st.all);
  const selfId = useApp((st) => st.identity?.userId);
  const now = useNow();
  const calls = all.filter((c) => c.state !== 'ringing');
  if (calls.length === 0) return null;
  return (
    <div className={s.bar} data-testid="call-bar">
      {calls.map((call) => {
        const held = call.held === true;
        return (
          <div
            key={call.callId}
            className={held ? `${s.row} ${s.held}` : s.row}
            data-testid="call-bar-row"
            data-held={held ? 'true' : 'false'}
          >
            <Call16Filled />
            <Text className={s.grow} truncate wrap={false}>
              {held
                ? strings.callBar.onHold(nameOf(call, selfId))
                : strings.callBar.inCall(nameOf(call, selfId))}
              {call.answeredAt
                ? ` · ${strings.calls.duration(Math.max(0, now - call.answeredAt))}`
                : ''}
            </Text>
            {held && (
              <Button
                size="small"
                appearance="primary"
                onClick={() => void core.invoke('calls.resume', { callId: call.callId })}
                data-testid="call-bar-resume"
              >
                {strings.calls.resume}
              </Button>
            )}
            <Button
              size="small"
              appearance="transparent"
              className={s.action}
              icon={<Open16Regular />}
              onClick={() => window.officemeshWindow?.focusCall(call.callId)}
              data-testid="call-bar-show"
            >
              {strings.callBar.show}
            </Button>
            <Button
              size="small"
              appearance="transparent"
              className={s.action}
              icon={<CallEnd16Filled />}
              onClick={() => void core.invoke('calls.hangup', { callId: call.callId })}
              data-testid="call-bar-leave"
            >
              {strings.callBar.leave}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
