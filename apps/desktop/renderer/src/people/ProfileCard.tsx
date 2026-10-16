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
  Person20Regular,
  ShieldCheckmark20Regular,
  ShieldError20Regular,
} from '@fluentui/react-icons';
import { useState } from 'react';
import type { PersonView } from '@officemesh/protocol/ipc';
import { presenceBadge, presenceLine } from '../format.ts';
import { PresenceDot } from '../shell/PresenceDot.tsx';
import { avatarSrc, core, nameOf, openChatWith, openProfile, useApp } from '../state.ts';
import { strings } from '../strings.ts';
import { useFreshPerson } from './ProfileParts.tsx';

const useStyles = makeStyles({
  card: {
    width: '320px',
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalM,
  },
  top: { display: 'flex', columnGap: tokens.spacingHorizontalM, alignItems: 'center' },
  muted: { color: tokens.colorNeutralForeground3 },
  presenceLine: { display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalXS },
  words: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS },
  verify: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalS,
    alignItems: 'flex-start',
    padding: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalXS,
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground2,
  },
  details: {
    display: 'grid',
    gridTemplateColumns: 'max-content 1fr',
    columnGap: tokens.spacingHorizontalL,
    rowGap: tokens.spacingVerticalXS,
    margin: 0,
    fontSize: tokens.fontSizeBase200,
    '& dt': { color: tokens.colorNeutralForeground3 },
    '& dd': { margin: 0, minWidth: 0, overflowWrap: 'anywhere' },
  },
  actions: { display: 'flex', columnGap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  notes: {
    whiteSpace: 'pre-wrap',
    display: '-webkit-box',
    '-webkit-line-clamp': '4',
    '-webkit-box-orient': 'vertical',
    overflow: 'hidden',
  },
  remote: {
    padding: `2px ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorPaletteDarkOrangeBackground2,
    color: tokens.colorPaletteDarkOrangeForeground2,
  },
});

export function ProfileCard({
  person,
  onClose,
  primary = 'chat',
}: {
  person: PersonView;
  onClose?: () => void;
  /** profile where the chat with them is already open: the button then opens their page. */
  primary?: 'chat' | 'profile';
}) {
  const styles = useStyles();
  const name = nameOf(person, person.userId);
  useFreshPerson(person.userId);
  // The safety phrase is how a serverless office tells a colleague from an impostor, but it is
  // a check made once, not the card's content: shown up front only when there is a warning.
  const [verifyOpen, setVerifyOpen] = useState(person.trust === 'new-device');
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
        <Avatar
          name={name}
          size={56}
          color="colorful"
          image={avatarSrc(person.avatarHash)}
          badge={presenceBadge(person.presence)}
        />
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
          <span className={styles.presenceLine}>
            <PresenceDot state={person.presence} />
            <Text size={200} className={styles.muted}>
              {presenceLine(person)}
            </Text>
          </span>
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

      <dl className={styles.details} data-testid="profile-details">
        {person.statusMessage && (
          <>
            <dt>{strings.person.statusMessage}</dt>
            <dd>{person.statusMessage}</dd>
          </>
        )}
        {person.workplace && (
          <>
            <dt>{strings.workplace.label}</dt>
            <dd data-testid="card-workplace">{strings.workplace.line[person.workplace]}</dd>
          </>
        )}
        {person.email && (
          <>
            <dt>{strings.person.email}</dt>
            <dd data-testid="card-email">{person.email}</dd>
          </>
        )}
        {person.notes && (
          <>
            <dt>{strings.person.notes}</dt>
            <dd className={styles.notes} data-testid="card-notes">
              {person.notes}
            </dd>
          </>
        )}
        {person.online && person.machine?.remote?.inUse && (
          <>
            <dt>{strings.personPage.remote}</dt>
            <dd>
              <span className={styles.remote} data-testid="card-remote">
                {strings.person.remoteInUse}
              </span>
            </dd>
          </>
        )}
        <dt>{strings.person.knownSince}</dt>
        <dd>{new Date(person.firstSeen).toLocaleDateString(undefined, { dateStyle: 'medium' })}</dd>
        {person.address && (
          <>
            <dt>{strings.person.address}</dt>
            <dd>{person.address}</dd>
          </>
        )}
      </dl>

      <div>
        <Button
          appearance="subtle"
          size="small"
          icon={<ShieldCheckmark20Regular />}
          aria-expanded={verifyOpen}
          onClick={() => setVerifyOpen(!verifyOpen)}
          data-testid="verify-toggle"
        >
          {person.verified ? strings.person.verifiedIdentity : strings.person.verifyIdentity}
        </Button>
        {verifyOpen && (
          <div className={styles.verify} data-testid="verify-panel">
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
            <Button
              size="small"
              onClick={() => void update({ verified: !person.verified })}
              data-testid="toggle-verified"
            >
              {person.verified ? strings.person.unmarkVerified : strings.person.markVerified}
            </Button>
          </div>
        )}
      </div>

      <div className={styles.actions}>
        <Button
          appearance="primary"
          icon={primary === 'profile' ? <Person20Regular /> : <Chat20Regular />}
          onClick={() => {
            onClose?.();
            if (primary === 'profile') openProfile(person.userId);
            else void openChatWith(person.userId);
          }}
          data-testid={primary === 'profile' ? 'card-profile' : 'card-chat'}
        >
          {primary === 'profile' ? strings.person.profile : strings.person.chat}
        </Button>
        {person.trust === 'new-device' && (
          <Button onClick={() => void update({ accept: true })} data-testid="accept-person">
            {strings.person.accept}
          </Button>
        )}
      </div>
    </div>
  );
}
