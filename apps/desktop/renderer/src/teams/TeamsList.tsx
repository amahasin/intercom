import { useEffect, useState } from 'react';
import {
  Avatar,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  makeStyles,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  mergeClasses,
  Radio,
  RadioGroup,
  Spinner,
  Text,
  tokens,
} from '@fluentui/react-components';
import {
  Add20Regular,
  LockClosed16Regular,
  MoreHorizontal16Regular,
  PeopleTeamAdd20Regular,
} from '@fluentui/react-icons';
import type { ConversationView, PublicTeamView, TeamView } from '@officemesh/protocol/ipc';
import { TextDialog } from '../chat/GroupDialogs.tsx';
import { PeoplePicker } from '../people/PeoplePicker.tsx';
import { core, putConversation, refreshTeams, selectConversation, useApp } from '../state.ts';
import { strings } from '../strings.ts';

const useStyles = makeStyles({
  root: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 },
  actions: {
    display: 'flex',
    columnGap: tokens.spacingHorizontalS,
    padding: `0 ${tokens.spacingHorizontalL} ${tokens.spacingVerticalS}`,
  },
  scroller: { flex: 1, overflowY: 'auto', minHeight: 0 },
  team: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL}`,
  },
  teamName: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  channel: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalXS,
    width: 'calc(100% - 16px)',
    margin: '0 8px',
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS} ${tokens.spacingVerticalXS} 44px`,
    border: 'none',
    borderRadius: tokens.borderRadiusMedium,
    background: 'transparent',
    color: tokens.colorNeutralForeground1,
    textAlign: 'left',
    cursor: 'pointer',
    ':hover': { background: tokens.colorSubtleBackgroundHover },
  },
  selected: { background: tokens.colorSubtleBackgroundSelected },
  unread: { fontWeight: tokens.fontWeightSemibold },
  archived: { color: tokens.colorNeutralForeground3, fontStyle: 'italic' },
  muted: { color: tokens.colorNeutralForeground3, padding: `0 ${tokens.spacingHorizontalL}` },
});

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function TeamsList() {
  const styles = useStyles();
  const teams = useApp((s) => s.teams);
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const list = Object.values(teams)
    .filter((t) => t.role)
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className={styles.root}>
      <div className={styles.actions}>
        <Button
          size="small"
          icon={<Add20Regular />}
          onClick={() => setCreating(true)}
          data-testid="team-create-open"
        >
          {strings.teams.create}
        </Button>
        <Button
          size="small"
          icon={<PeopleTeamAdd20Regular />}
          onClick={() => setJoining(true)}
          data-testid="team-join-open"
        >
          {strings.teams.join}
        </Button>
      </div>
      <div className={styles.scroller} data-testid="teams-list">
        {list.length === 0 && (
          <Text as="p" size={200} className={styles.muted}>
            {strings.teams.empty}
          </Text>
        )}
        {list.map((t) => (
          <TeamEntry key={t.teamId} team={t} />
        ))}
      </div>
      {creating && <CreateTeamDialog onClose={() => setCreating(false)} />}
      {joining && <JoinTeamDialog onClose={() => setJoining(false)} />}
    </div>
  );
}

function TeamEntry({ team }: { team: TeamView }) {
  const styles = useStyles();
  const selected = useApp((s) => s.selectedConv);
  const conversations = useApp((s) => s.conversations);
  const [dialog, setDialog] = useState<'channel' | 'rename' | undefined>();
  const owner = team.role === 'owner';
  return (
    <div data-testid="team" data-team={team.teamId}>
      <div className={styles.team}>
        <Avatar shape="square" size={28} name={team.name} color="colorful" />
        <Text weight="semibold" className={styles.teamName}>
          {team.name}
        </Text>
        <Menu>
          <MenuTrigger disableButtonEnhancement>
            <Button
              size="small"
              appearance="subtle"
              icon={<MoreHorizontal16Regular />}
              aria-label={strings.message.more}
              data-testid="team-more"
            />
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              {owner && (
                <MenuItem onClick={() => setDialog('channel')} data-testid="team-add-channel">
                  {strings.teams.addChannel}
                </MenuItem>
              )}
              {owner && (
                <MenuItem onClick={() => setDialog('rename')} data-testid="team-rename">
                  {strings.teams.renameTeam}
                </MenuItem>
              )}
              <MenuItem
                data-testid="team-leave"
                onClick={() => {
                  if (window.confirm(strings.groups.leaveConfirm)) {
                    void core
                      .invoke('conversations.leave', { convId: team.teamId })
                      .then(refreshTeams);
                  }
                }}
              >
                {strings.teams.leave}
              </MenuItem>
            </MenuList>
          </MenuPopover>
        </Menu>
      </div>
      {team.channels.map((c) => {
        const live = conversations[c.convId] ?? c;
        return (
          <ChannelRow
            key={c.convId}
            teamId={team.teamId}
            channel={live}
            owner={owner}
            selected={selected === c.convId}
          />
        );
      })}
      {dialog === 'channel' && (
        <CreateChannelDialog teamId={team.teamId} onClose={() => setDialog(undefined)} />
      )}
      {dialog === 'rename' && (
        <TextDialog
          title={strings.teams.renameTeam}
          label={strings.teams.name}
          initial={team.name}
          onClose={() => setDialog(undefined)}
          onSubmit={(name) =>
            core.invoke('teams.rename', { teamId: team.teamId, name }).then(refreshTeams)
          }
        />
      )}
    </div>
  );
}

function ChannelRow({
  teamId,
  channel,
  owner,
  selected,
}: {
  teamId: string;
  channel: ConversationView;
  owner: boolean;
  selected: boolean;
}) {
  const styles = useStyles();
  const [renaming, setRenaming] = useState(false);
  const general = channel.title === 'General';
  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      <button
        type="button"
        className={mergeClasses(styles.channel, selected && styles.selected)}
        onClick={() => void selectConversation(channel.convId)}
        data-testid="channel-row"
        data-conv={channel.convId}
      >
        <Text
          className={mergeClasses(
            channel.unread > 0 && styles.unread,
            channel.archived && styles.archived,
          )}
          size={300}
        >
          {channel.title}
        </Text>
        {channel.private && <LockClosed16Regular aria-label={strings.teams.privateChannel} />}
      </button>
      {owner && !general && (
        <Menu>
          <MenuTrigger disableButtonEnhancement>
            <Button
              size="small"
              appearance="subtle"
              icon={<MoreHorizontal16Regular />}
              aria-label={strings.message.more}
              data-testid="channel-more"
            />
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              <MenuItem onClick={() => setRenaming(true)} data-testid="channel-rename">
                {strings.teams.renameChannel}
              </MenuItem>
              <MenuItem
                data-testid="channel-archive"
                onClick={() =>
                  void core
                    .invoke('channels.archive', {
                      teamId,
                      channelId: channel.convId,
                      archived: !channel.archived,
                    })
                    .then(putConversation)
                }
              >
                {channel.archived ? strings.teams.unarchive : strings.teams.archive}
              </MenuItem>
            </MenuList>
          </MenuPopover>
        </Menu>
      )}
      {renaming && (
        <TextDialog
          title={strings.teams.renameChannel}
          label={strings.teams.channelName}
          initial={channel.title}
          onClose={() => setRenaming(false)}
          onSubmit={(name) =>
            core
              .invoke('channels.rename', { teamId, channelId: channel.convId, name })
              .then(putConversation)
          }
        />
      )}
    </div>
  );
}

function CreateTeamDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('private');
  const [members, setMembers] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  return (
    <Dialog open onOpenChange={(_e, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{strings.teams.create}</DialogTitle>
          <DialogContent style={{ display: 'flex', flexDirection: 'column', rowGap: 12 }}>
            <Field label={strings.teams.name} required validationMessage={error}>
              <Input
                value={name}
                maxLength={100}
                onChange={(_e, d) => setName(d.value)}
                data-testid="team-name"
              />
            </Field>
            <Field label={strings.teams.description}>
              <Input
                value={description}
                maxLength={500}
                onChange={(_e, d) => setDescription(d.value)}
              />
            </Field>
            <Field label={strings.teams.visibility}>
              <RadioGroup
                value={visibility}
                onChange={(_e, d) => setVisibility(d.value as 'public' | 'private')}
              >
                <Radio value="private" label={strings.teams.private} />
                <Radio value="public" label={strings.teams.public} data-testid="team-public" />
              </RadioGroup>
            </Field>
            <Field label={strings.teams.members}>
              <PeoplePicker selected={members} onChange={setMembers} />
            </Field>
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose}>{strings.me.cancel}</Button>
            <Button
              appearance="primary"
              disabled={!name.trim()}
              data-testid="team-create"
              onClick={async () => {
                try {
                  const team = await core.invoke('teams.create', {
                    name: name.trim(),
                    ...(description.trim() && { description: description.trim() }),
                    visibility,
                    members,
                  });
                  await refreshTeams();
                  onClose();
                  if (team.channels[0]) await selectConversation(team.channels[0].convId);
                } catch (err) {
                  setError(errorText(err));
                }
              }}
            >
              {strings.groups.create}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function CreateChannelDialog({ teamId, onClose }: { teamId: string; onClose: () => void }) {
  const [name, setName] = useState('');
  const [isPrivate, setPrivate] = useState(false);
  const [members, setMembers] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  return (
    <Dialog open onOpenChange={(_e, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{strings.teams.addChannel}</DialogTitle>
          <DialogContent style={{ display: 'flex', flexDirection: 'column', rowGap: 12 }}>
            <Field label={strings.teams.channelName} required validationMessage={error}>
              <Input
                value={name}
                maxLength={60}
                onChange={(_e, d) => setName(d.value)}
                data-testid="channel-name"
              />
            </Field>
            <Checkbox
              checked={isPrivate}
              onChange={(_e, d) => setPrivate(d.checked === true)}
              label={strings.teams.privateChannel}
              data-testid="channel-private"
            />
            {isPrivate && <PeoplePicker selected={members} onChange={setMembers} />}
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose}>{strings.me.cancel}</Button>
            <Button
              appearance="primary"
              disabled={!name.trim()}
              data-testid="channel-create"
              onClick={async () => {
                try {
                  const channel = await core.invoke('channels.create', {
                    teamId,
                    name: name.trim(),
                    private: isPrivate,
                    ...(isPrivate && { members }),
                  });
                  await refreshTeams();
                  onClose();
                  await selectConversation(channel.convId);
                } catch (err) {
                  setError(errorText(err));
                }
              }}
            >
              {strings.groups.create}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function JoinTeamDialog({ onClose }: { onClose: () => void }) {
  const [found, setFound] = useState<PublicTeamView[] | undefined>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    void core
      .invoke('teams.discover', {})
      .then(setFound, (err: unknown) => setError(errorText(err)));
  }, []);
  return (
    <Dialog open onOpenChange={(_e, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{strings.teams.join}</DialogTitle>
          <DialogContent
            style={{ display: 'flex', flexDirection: 'column', rowGap: 8 }}
            data-testid="team-discover"
          >
            {!found && !error && <Spinner size="small" label={strings.teams.discovering} />}
            {error && <Text>{error}</Text>}
            {found?.length === 0 && <Text>{strings.teams.noneFound}</Text>}
            {found?.map((t) => (
              <div key={t.teamId} style={{ display: 'flex', alignItems: 'center', columnGap: 8 }}>
                <Avatar shape="square" size={28} name={t.name} color="colorful" />
                <Text style={{ flex: 1 }}>{t.name}</Text>
                <Button
                  appearance="primary"
                  size="small"
                  data-testid="team-join"
                  onClick={async () => {
                    try {
                      const team = await core.invoke('teams.join', { teamId: t.teamId });
                      await refreshTeams();
                      onClose();
                      if (team.channels[0]) await selectConversation(team.channels[0].convId);
                    } catch (err) {
                      setError(errorText(err));
                    }
                  }}
                >
                  {strings.teams.joinButton}
                </Button>
              </div>
            ))}
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose}>{strings.me.cancel}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
