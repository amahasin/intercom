import { useEffect, useState } from 'react';
import { Avatar, Button, makeStyles, mergeClasses, Text, tokens } from '@fluentui/react-components';
import {
  ArrowDownLeft16Regular,
  ArrowUpRight16Regular,
  Call20Regular,
  Video20Regular,
} from '@fluentui/react-icons';
import type { CallHistoryItem } from '@officemesh/protocol/ipc';
import { shortTime } from '../format.ts';
import { avatarSrc, core, displayName, useApp } from '../state.ts';
import { strings } from '../strings.ts';
import { startCall } from './engine.ts';

const useStyles = makeStyles({
  root: { flex: 1, overflowY: 'auto', minHeight: 0 },
  row: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL}`,
  },
  text: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' },
  ellipsis: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  missed: { color: tokens.colorPaletteRedForeground1 },
  muted: {
    color: tokens.colorNeutralForeground3,
    display: 'flex',
    alignItems: 'center',
    columnGap: '4px',
  },
  note: { padding: `0 ${tokens.spacingHorizontalL}`, color: tokens.colorNeutralForeground3 },
});

/** Call history (plan section 2): direction, outcome, duration, and call back. */
export function CallsPane() {
  const s = useStyles();
  const [items, setItems] = useState<CallHistoryItem[]>([]);
  const people = useApp((st) => st.people);
  useEffect(() => {
    void core.invoke('calls.history', {}).then(setItems);
    return core.on('calls.history.changed', ({ items: next }) => setItems(next));
  }, []);
  if (items.length === 0) {
    return (
      <Text as="p" size={200} className={s.note}>
        {strings.calls.noHistory}
      </Text>
    );
  }
  return (
    <div className={s.root} data-testid="call-history">
      {items.map((c) => {
        const names = c.peers.map(displayName).join(', ');
        const missed = c.outcome === 'missed';
        const outcome = c.outcome ? strings.calls.outcome[c.outcome] : '';
        const length =
          c.answeredAt && c.endedAt ? ` · ${strings.calls.duration(c.endedAt - c.answeredAt)}` : '';
        return (
          <div
            key={c.callId}
            className={s.row}
            data-testid="call-history-item"
            data-outcome={c.outcome ?? ''}
          >
            <Avatar
              name={names}
              size={32}
              color="colorful"
              image={c.peers.length === 1 ? avatarSrc(people[c.peers[0]!]?.avatarHash) : undefined}
            />
            <span className={s.text}>
              <Text
                weight={missed ? 'semibold' : 'regular'}
                className={mergeClasses(s.ellipsis, missed && s.missed)}
              >
                {names}
              </Text>
              <Text size={200} className={s.muted}>
                {c.direction === 'in' ? <ArrowDownLeft16Regular /> : <ArrowUpRight16Regular />}
                {outcome}
                {length} · {shortTime(c.startedAt)}
              </Text>
            </span>
            <Button
              appearance="subtle"
              icon={c.media === 'video' ? <Video20Regular /> : <Call20Regular />}
              aria-label={strings.calls.callBack}
              title={strings.calls.callBack}
              onClick={() => void startCall(c.peers, c.media, c.convId)}
              data-testid="call-back"
            />
          </div>
        );
      })}
    </div>
  );
}
