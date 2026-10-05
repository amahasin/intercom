import {
  Avatar,
  Badge,
  Button,
  makeStyles,
  MessageBar,
  MessageBarBody,
  Text,
  tokens,
} from '@fluentui/react-components';
import {
  Chat20Regular,
  CheckmarkCircle20Filled,
  ShieldError20Regular,
} from '@fluentui/react-icons';
import type { PersonView } from '@officemesh/protocol/ipc';
import { presenceBadge, relativeAgo } from '../format.ts';
import { core, nameOf, openChatWith, useApp } from '../state.ts';
import { strings } from '../strings.ts';

const useStyles = makeStyles({
  card: {
    width: '320px',
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalM,
  },
  top: { display: 'flex', columnGap: tokens.spacingHorizontalM, alignItems: 'center' },
  muted: { color: tokens.colorNeutralForeground3 },
  words: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS },
  actions: { display: 'flex', columnGap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
});

export function ProfileCard({ person, onClose }: { person: PersonView; onClose?: () => void }) {
  const styles = useStyles();
  const name = nameOf(person, person.userId);
  const update = async (change: { accept?: boolean; verified?: boolean }) => {
    const next = await core.invoke('people.setTrust', { userId: person.userId, ...change });
    useApp.setState((s) => ({ people: { ...s.people, [next.userId]: next } }));
    // Accepting settles the question the card was raising: close it, and Fluent returns
    // focus to the avatar that opened it (the Accept button itself is gone).
    if (change.accept) onClose?.();
  };
  return (
    <div
      className={styles.card}
      aria-label={strings.person.profileCard(name)}
      data-testid="profile-card"
    >
      <div className={styles.top}>
        <Avatar name={name} size={56} color="colorful" badge={presenceBadge(person.presence)} />
        <div>
          <Text as="h3" size={400} weight="semibold" block>
            {name}{' '}
            {person.verified && (
              <CheckmarkCircle20Filled
                aria-label={strings.person.verified}
                primaryFill={tokens.colorPaletteGreenForeground1}
              />
            )}
          </Text>
          {person.jobTitle && <Text block>{person.jobTitle}</Text>}
          <Text size={200} className={styles.muted} block>
            {person.online
              ? strings.presence[person.presence]
              : strings.person.lastSeen(relativeAgo(person.lastSeen))}
          </Text>
          {person.statusMessage && (
            <Text size={200} block>
              {person.statusMessage}
            </Text>
          )}
        </div>
      </div>

      {person.trust === 'new-device' && (
        <MessageBar
          intent="warning"
          icon={<ShieldError20Regular />}
          data-testid="new-device-warning"
        >
          <MessageBarBody>{strings.person.unverifiedExplain(name)}</MessageBarBody>
        </MessageBar>
      )}

      <div>
        <Text size={200} weight="semibold" block>
          {strings.person.safetyPhrase}
        </Text>
        <div className={styles.words} data-testid="peer-safety-phrase">
          {person.safetyPhrase.map((w, i) => (
            <Badge key={i} appearance="tint" shape="rounded">
              {w}
            </Badge>
          ))}
        </div>
        <Text size={200} className={styles.muted} block>
          {strings.person.safetyHelp}
        </Text>
      </div>

      <div className={styles.actions}>
        <Button
          appearance="primary"
          icon={<Chat20Regular />}
          onClick={() => {
            onClose?.();
            void openChatWith(person.userId);
          }}
        >
          {strings.person.chat}
        </Button>
        {person.trust === 'new-device' && (
          <Button onClick={() => void update({ accept: true })} data-testid="accept-person">
            {strings.person.accept}
          </Button>
        )}
        <Button
          appearance="subtle"
          onClick={() => void update({ verified: !person.verified })}
          data-testid="toggle-verified"
        >
          {person.verified ? strings.person.unmarkVerified : strings.person.markVerified}
        </Button>
      </div>
    </div>
  );
}
