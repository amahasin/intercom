import { useState } from 'react';
import {
  Avatar,
  Button,
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
  MenuDivider,
  MenuGroupHeader,
  MenuItem,
  MenuItemRadio,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Select,
  Text,
  tokens,
} from '@fluentui/react-components';
import type { ManualPresenceState } from '@officemesh/protocol';
import { presenceBadge } from '../format.ts';
import { SettingsDialog } from './SettingsDialog.tsx';
import { avatarSrc, core, useApp } from '../state.ts';
import { strings } from '../strings.ts';

const STATES: ManualPresenceState[] = ['available', 'busy', 'dnd', 'brb', 'away'];

const useStyles = makeStyles({
  trigger: {
    border: 'none',
    background: 'transparent',
    padding: 0,
    cursor: 'pointer',
    borderRadius: '50%',
  },
  fields: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM },
  note: {
    padding: `0 ${tokens.spacingHorizontalS}`,
    color: tokens.colorNeutralForeground3,
    maxWidth: '240px',
  },
});

/** The avatar in the title bar: presence, status message and profile editing. */
export function MeMenu() {
  const styles = useStyles();
  const identity = useApp((s) => s.identity);
  const presence = useApp((s) => s.presence);
  const [editing, setEditing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  if (!identity) return null;
  const effective = presence?.effective ?? 'available';

  const setState = async (state: ManualPresenceState) => {
    useApp.setState({ presence: await core.invoke('presence.set', { state }) });
  };

  return (
    <>
      <Menu
        checkedValues={{ presence: [presence?.manual ?? 'available'] }}
        onCheckedValueChange={(_e, d) => void setState(d.checkedItems[0] as ManualPresenceState)}
      >
        <MenuTrigger disableButtonEnhancement>
          <button
            type="button"
            className={styles.trigger}
            aria-label={`${strings.me.menuLabel}: ${identity.displayName}, ${strings.presence[effective]}`}
            data-testid="me-avatar"
            data-presence={effective}
          >
            <Avatar
              name={identity.displayName}
              size={32}
              color="colorful"
              image={avatarSrc(identity.avatarHash)}
              badge={presenceBadge(effective)}
            />
          </button>
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            <MenuGroupHeader>{identity.displayName}</MenuGroupHeader>
            {STATES.map((s) => (
              <MenuItemRadio key={s} name="presence" value={s} data-testid={`presence-${s}`}>
                {strings.presence[s]}
              </MenuItemRadio>
            ))}
            {(presence?.idle || presence?.locked) && effective === 'away' && (
              <Text size={200} block className={styles.note}>
                {strings.me.autoAway}
              </Text>
            )}
            <MenuDivider />
            <MenuItem onClick={() => setEditing(true)} data-testid="edit-profile">
              {strings.me.editProfile}
            </MenuItem>
            <MenuItem onClick={() => setSettingsOpen(true)} data-testid="open-settings">
              {strings.settings.title}
            </MenuItem>
          </MenuList>
        </MenuPopover>
      </Menu>
      {editing && <EditProfileDialog onClose={() => setEditing(false)} />}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </>
  );
}

function EditProfileDialog({ onClose }: { onClose: () => void }) {
  const styles = useStyles();
  const identity = useApp((s) => s.identity)!;
  const [displayName, setDisplayName] = useState(identity.displayName);
  const [jobTitle, setJobTitle] = useState(identity.jobTitle ?? '');
  const [statusMessage, setStatusMessage] = useState(identity.statusMessage ?? '');
  const [clearAfter, setClearAfter] = useState<'never' | 'hour' | 'today' | 'week'>('never');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const now = new Date();
      const endOfDay = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        23,
        59,
        59,
      ).getTime();
      const expiry =
        clearAfter === 'hour'
          ? now.getTime() + 3_600_000
          : clearAfter === 'today'
            ? endOfDay
            : clearAfter === 'week'
              ? endOfDay + 6 * 86_400_000
              : null;
      const next = await core.invoke('profile.update', {
        displayName,
        jobTitle,
        statusMessage,
        statusExpiresAt: statusMessage ? expiry : null,
      });
      useApp.setState({ identity: next });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(_e, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{strings.me.profileTitle}</DialogTitle>
          <DialogContent className={styles.fields}>
            <Field label={strings.me.displayName} required>
              <Input
                value={displayName}
                maxLength={64}
                onChange={(_e, d) => setDisplayName(d.value)}
                data-testid="profile-name-input"
              />
            </Field>
            <Field label={strings.me.jobTitle}>
              <Input value={jobTitle} maxLength={64} onChange={(_e, d) => setJobTitle(d.value)} />
            </Field>
            <Field label={strings.me.statusMessage}>
              <Input
                value={statusMessage}
                maxLength={280}
                placeholder={strings.me.statusPlaceholder}
                onChange={(_e, d) => setStatusMessage(d.value)}
                data-testid="profile-status-input"
              />
            </Field>
            <Field label={strings.settings.clearAfter}>
              <Select
                value={clearAfter}
                onChange={(_e, d) => setClearAfter(d.value as typeof clearAfter)}
              >
                {(['never', 'hour', 'today', 'week'] as const).map((k) => (
                  <option key={k} value={k}>
                    {strings.settings.clearOptions[k]}
                  </option>
                ))}
              </Select>
            </Field>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              {strings.me.cancel}
            </Button>
            <Button
              appearance="primary"
              disabled={!displayName.trim() || saving}
              onClick={() => void save()}
              data-testid="profile-save"
            >
              {strings.me.save}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
