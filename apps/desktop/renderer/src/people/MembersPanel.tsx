import { useCallback, useEffect, useState } from 'react';
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  makeStyles,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Text,
  tokens,
} from '@fluentui/react-components';
import { MoreHorizontal20Regular, PersonAdd20Regular } from '@fluentui/react-icons';
import type { MemberView } from '@officemesh/protocol/ipc';
import { avatarSrc, core, useApp } from '../state.ts';
import { PersonHover } from './ProfileHover.tsx';
import { strings } from '../strings.ts';
import { PeoplePicker } from './PeoplePicker.tsx';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalXL,
  },
  bar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  row: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    ':hover': { background: tokens.colorSubtleBackgroundHover },
  },
  name: { flex: 1, minWidth: 0 },
});

/**
 * Members of a group chat, team or channel. `manage` says what this user may change:
 * in a group anyone may add and remove; in a team or channel only owners may.
 */
export function MembersPanel({
  convId,
  teamId,
  manage,
}: {
  convId: string;
  /** Set for teams (role changes act on the team). */
  teamId?: string;
  manage: boolean;
}) {
  const styles = useStyles();
  const selfId = useApp((s) => s.identity?.userId);
  const [members, setMembers] = useState<MemberView[]>([]);
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const version = useApp((s) => s.conversations[convId]?.memberCount);

  const reload = useCallback(
    () =>
      void core
        .invoke('conversations.members', { convId })
        .then(setMembers)
        .catch(() => setMembers([])),
    [convId],
  );
  useEffect(() => reload(), [reload, version]);

  const run = (p: Promise<MemberView[]>) =>
    void p
      .then(setMembers)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));

  return (
    <div className={styles.root} data-testid="members-panel">
      <div className={styles.bar}>
        <Text weight="semibold">{strings.groups.members(members.length)}</Text>
        {manage && (
          <Button
            icon={<PersonAdd20Regular />}
            onClick={() => setAdding(true)}
            data-testid="members-add"
          >
            {strings.groups.add}
          </Button>
        )}
      </div>
      {error && (
        <Text size={200} style={{ color: tokens.colorPaletteRedForeground1 }}>
          {error}
        </Text>
      )}
      {members.map((m) => (
        <div key={m.userId} className={styles.row} data-testid="member-row" data-user={m.userId}>
          <PersonHover userId={m.userId}>
            <Avatar
              size={32}
              name={m.name}
              color="colorful"
              image={avatarSrc(m.avatarHash)}
              badge={{ status: m.online ? 'available' : 'offline' }}
            />
          </PersonHover>
          <Text className={styles.name}>
            {m.name}
            {m.userId === selfId ? ` (${strings.groups.you})` : ''}
          </Text>
          {m.role === 'owner' && teamId && (
            <Badge appearance="tint" data-testid="member-owner">
              {strings.groups.owner}
            </Badge>
          )}
          {manage && m.userId !== selfId && (
            <Menu>
              <MenuTrigger disableButtonEnhancement>
                <Button
                  appearance="subtle"
                  icon={<MoreHorizontal20Regular />}
                  aria-label={strings.message.more}
                  data-testid="member-more"
                />
              </MenuTrigger>
              <MenuPopover>
                <MenuList>
                  {teamId && (
                    <MenuItem
                      onClick={() =>
                        run(
                          core.invoke('teams.setRole', {
                            teamId,
                            userId: m.userId,
                            role: m.role === 'owner' ? 'member' : 'owner',
                          }),
                        )
                      }
                      data-testid="member-role"
                    >
                      {m.role === 'owner' ? strings.groups.makeMember : strings.groups.makeOwner}
                    </MenuItem>
                  )}
                  <MenuItem
                    onClick={() =>
                      run(core.invoke('conversations.removeMember', { convId, userId: m.userId }))
                    }
                    data-testid="member-remove"
                  >
                    {strings.groups.remove}
                  </MenuItem>
                </MenuList>
              </MenuPopover>
            </Menu>
          )}
        </div>
      ))}
      {adding && (
        <Dialog open onOpenChange={(_e, d) => !d.open && setAdding(false)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>{strings.groups.add}</DialogTitle>
              <DialogContent>
                <PeoplePicker
                  selected={picked}
                  onChange={setPicked}
                  exclude={members.map((m) => m.userId)}
                />
              </DialogContent>
              <DialogActions>
                <Button onClick={() => setAdding(false)}>{strings.me.cancel}</Button>
                <Button
                  appearance="primary"
                  disabled={picked.length === 0}
                  data-testid="members-add-confirm"
                  onClick={() => {
                    run(core.invoke('conversations.addMembers', { convId, userIds: picked }));
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
    </div>
  );
}
