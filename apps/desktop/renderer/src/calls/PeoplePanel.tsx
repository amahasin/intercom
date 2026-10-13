import { useState } from 'react';
import {
  Avatar,
  Button,
  makeStyles,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Text,
  tokens,
} from '@fluentui/react-components';
import {
  HandRight16Filled,
  MicOff16Regular,
  MoreHorizontal20Regular,
  PauseCircle16Regular,
  PersonAdd20Regular,
  ShareScreenStart16Regular,
} from '@fluentui/react-icons';
import type { CallView } from '@officemesh/protocol/ipc';
import { avatarSrc, displayName, useApp } from '../state.ts';
import { strings } from '../strings.ts';
import { AddPeopleDialog } from './AddPeople.tsx';
import { control } from './engine.ts';

const useStyles = makeStyles({
  panel: {
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    background: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
  },
  head: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalS,
    padding: tokens.spacingHorizontalM,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  headTitle: { flex: 1, minWidth: 0 },
  hands: {
    display: 'inline-flex',
    alignItems: 'center',
    columnGap: '2px',
    marginLeft: tokens.spacingHorizontalS,
    color: tokens.colorPaletteMarigoldForeground1,
  },
  calling: { color: tokens.colorNeutralForeground3 },
  list: { flex: 1, overflowY: 'auto', minHeight: 0, padding: tokens.spacingHorizontalS },
  row: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    ':hover': { background: tokens.colorSubtleBackgroundHover },
  },
  name: { flex: 1, minWidth: 0 },
  icons: { display: 'flex', columnGap: '4px', color: tokens.colorNeutralForeground3 },
  hand: { color: tokens.colorPaletteMarigoldForeground1 },
});

/** Everyone in the call, with who is muted, has a hand up, is sharing or on hold. */
export function PeoplePanel({
  call,
  organizerView,
  spotlight,
}: {
  call: CallView;
  organizerView: boolean;
  spotlight: string | undefined;
}) {
  const s = useStyles();
  const selfId = useApp((st) => st.identity?.userId);
  const [adding, setAdding] = useState(false);
  const hands = call.participants.filter((p) => p.hand).length;
  return (
    <aside className={s.panel} aria-label={strings.inCall.people} data-testid="people-panel">
      <div className={s.head}>
        <Text weight="semibold" className={s.headTitle} truncate wrap={false}>
          {strings.inCall.people} ({call.participants.length})
          {hands > 0 && (
            <span
              className={s.hands}
              data-testid="people-hands"
              title={strings.inCall.handsRaised(hands)}
            >
              <HandRight16Filled aria-hidden="true" />
              {hands}
            </span>
          )}
        </Text>
        <Button
          size="small"
          appearance="primary"
          icon={<PersonAdd20Regular />}
          onClick={() => setAdding(true)}
          data-testid="people-add"
        >
          {strings.calls.addPeople}
        </Button>
      </div>
      <div className={s.list}>
        {call.participants.map((p) => (
          <div key={p.userId} className={s.row} data-testid="people-row" data-user={p.userId}>
            <Avatar name={p.name} size={28} color="colorful" image={avatarSrc(p.avatarHash)} />
            <Text className={s.name} truncate wrap={false}>
              {p.userId === selfId ? `${p.name} ${strings.calls.youParen}` : p.name}
              {p.userId === call.organizer ? ` · ${strings.inCall.organizer}` : ''}
            </Text>
            <span className={s.icons}>
              {p.hand && (
                <HandRight16Filled className={s.hand} aria-label={strings.inCall.handRaised} />
              )}
              {p.sharing && <ShareScreenStart16Regular aria-label={strings.calls.share} />}
              {p.onHold && <PauseCircle16Regular aria-label={strings.calls.onHold} />}
              {p.muted && <MicOff16Regular aria-label={strings.calls.muted} />}
            </span>
            {organizerView && p.userId !== selfId && (
              <Menu>
                <MenuTrigger disableButtonEnhancement>
                  <Button
                    size="small"
                    appearance="subtle"
                    icon={<MoreHorizontal20Regular />}
                    aria-label={strings.inCall.more}
                  />
                </MenuTrigger>
                <MenuPopover>
                  <MenuList>
                    <MenuItem onClick={() => control('mute', p.userId)}>
                      {strings.inCall.mute}
                    </MenuItem>
                    <MenuItem
                      onClick={() => control('spotlight', spotlight === p.userId ? null : p.userId)}
                    >
                      {spotlight === p.userId
                        ? strings.inCall.stopSpotlight
                        : strings.inCall.spotlight}
                    </MenuItem>
                    <MenuItem onClick={() => control('remove', p.userId)}>
                      {strings.inCall.remove}
                    </MenuItem>
                  </MenuList>
                </MenuPopover>
              </Menu>
            )}
          </div>
        ))}
        {call.invited.map((userId) => (
          <div key={userId} className={s.row} data-testid="people-invited" data-user={userId}>
            <Avatar name={displayName(userId)} size={28} color="colorful" />
            <Text className={s.name} truncate wrap={false}>
              {displayName(userId)}
            </Text>
            <Text size={200} className={s.calling}>
              {strings.inCall.calling}
            </Text>
          </div>
        ))}
      </div>
      {adding && <AddPeopleDialog onClose={() => setAdding(false)} />}
    </aside>
  );
}
