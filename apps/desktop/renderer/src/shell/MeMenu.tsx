import { useState } from 'react';
import {
  Avatar,
  makeStyles,
  Menu,
  MenuDivider,
  MenuGroupHeader,
  MenuItem,
  MenuItemRadio,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Text,
  tokens,
} from '@fluentui/react-components';
import type { ManualPresenceState } from '@officemesh/protocol';
import { presenceBadge } from '../format.ts';
import { PresenceDot } from './PresenceDot.tsx';
import { SettingsDialog, type SettingsCategory } from './SettingsDialog.tsx';
import { avatarSrc, core, useApp } from '../state.ts';
import { strings } from '../strings.ts';

const STATES: ManualPresenceState[] = ['available', 'busy', 'dnd', 'brb', 'away'];

const useStyles = makeStyles({
  trigger: {
    WebkitAppRegion: 'no-drag',
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
  const [settingsAt, setSettingsAt] = useState<SettingsCategory | undefined>();
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
            aria-label={`${strings.me.menuLabel}: ${identity.displayName}, ${presence?.inCall ? strings.inCallStatus : strings.presence[effective]}`}
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
              <MenuItemRadio
                key={s}
                name="presence"
                value={s}
                icon={<PresenceDot state={s} />}
                data-testid={`presence-${s}`}
              >
                {strings.presence[s]}
              </MenuItemRadio>
            ))}
            {(presence?.idle || presence?.locked) && effective === 'away' && (
              <Text size={200} block className={styles.note}>
                {strings.me.autoAway}
              </Text>
            )}
            <MenuDivider />
            <MenuItem onClick={() => setSettingsAt('profile')} data-testid="edit-profile">
              {strings.me.editProfile}
            </MenuItem>
            <MenuItem onClick={() => setSettingsAt('general')} data-testid="open-settings">
              {strings.settings.title}
            </MenuItem>
          </MenuList>
        </MenuPopover>
      </Menu>
      {settingsAt && (
        <SettingsDialog initial={settingsAt} onClose={() => setSettingsAt(undefined)} />
      )}
    </>
  );
}
