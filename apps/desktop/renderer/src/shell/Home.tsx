/**
 * Your own page: what colleagues see about you and this PC, and your identity. It is the page the
 * Chat rail opens with, and the one pressing Escape twice in a chat comes back to.
 */
import { useState } from 'react';
import { Badge, Button, Text, Title2 } from '@fluentui/react-components';
import { Edit20Regular, Person20Regular, ShieldCheckmark20Regular } from '@fluentui/react-icons';
import { presenceBadge } from '../format.ts';
import { EnlargeablePicture } from '../people/EnlargeablePicture.tsx';
import {
  Card,
  ContactCard,
  Fact,
  JoinedValue,
  MachineCard,
  useProfileStyles,
  WorkplaceBadge,
} from '../people/ProfileParts.tsx';
import { useApp } from '../state.ts';
import { strings } from '../strings.ts';
import { PresenceDot } from './PresenceDot.tsx';
import { SettingsDialog } from './SettingsDialog.tsx';

export function Home() {
  const s = useProfileStyles();
  const identity = useApp((st) => st.identity);
  const info = useApp((st) => st.info);
  const presence = useApp((st) => st.presence);
  const [editing, setEditing] = useState(false);
  if (!identity || !info) return <main className={s.page} />;
  const t = strings.personPage;
  const state = presence?.effective ?? 'available';
  const status = presence?.inCall ? strings.inCallStatus : strings.presence[state];
  return (
    <main className={s.page} data-testid="own-page">
      <div className={s.inner}>
        <div className={s.hero} style={{ position: 'relative', paddingRight: 168 }}>
          <EnlargeablePicture
            name={identity.displayName}
            avatarHash={identity.avatarHash}
            size={96}
            badge={presenceBadge(state)}
            data-testid="welcome-avatar"
          />
          <div className={s.who}>
            <Title2 as="h2" block>
              {strings.home.welcome(identity.displayName)}
            </Title2>
            <Text size={400} className={identity.jobTitle ? undefined : s.muted}>
              {identity.jobTitle ?? t.noJobTitle}
            </Text>
            <span className={s.presenceLine}>
              <PresenceDot state={state} />
              <Text size={300}>{status}</Text>
            </span>
            {identity.workplace && (
              <div className={s.badges}>
                <WorkplaceBadge workplace={identity.workplace} />
              </div>
            )}
            {identity.statusMessage && (
              <div className={s.quote}>
                <Text italic>{identity.statusMessage}</Text>
              </div>
            )}
            <Text as="p" block className={s.muted} style={{ margin: '8px 0 0' }}>
              {strings.home.intro}
            </Text>
          </div>
          <Button
            appearance="primary"
            icon={<Edit20Regular />}
            style={{ position: 'absolute', top: 16, right: 16 }}
            onClick={() => setEditing(true)}
            data-testid="own-edit-profile"
          >
            {strings.home.editProfile}
          </Button>
        </div>

        <div className={s.columns}>
          <div className={s.column} data-testid="own-left">
            <MachineCard
              machine={info.machine}
              address={info.addresses?.join(', ')}
              appVersion={info.appVersion}
              footnote={strings.home.machineNote}
            />

            <Card icon={<Person20Regular />} title={t.status} testId="own-status">
              <dl className={s.facts}>
                <Fact
                  label={t.availability}
                  value={
                    <>
                      <PresenceDot state={state} />
                      {status}
                    </>
                  }
                />
                <Fact
                  label={strings.workplace.label}
                  value={
                    identity.workplace ? (
                      strings.workplace.line[identity.workplace]
                    ) : (
                      <span className={s.muted}>{strings.workplace.option.none}</span>
                    )
                  }
                  testId="own-workplace"
                />
                <Fact
                  label={t.statusMessage}
                  value={
                    identity.statusMessage ?? <span className={s.muted}>{t.noStatusMessage}</span>
                  }
                />
                <Fact
                  label={t.jobTitle}
                  value={identity.jobTitle ?? <span className={s.muted}>{t.noJobTitle}</span>}
                />
                <Fact
                  label={t.withCompany}
                  value={
                    identity.joinedOn ? (
                      <JoinedValue joinedOn={identity.joinedOn} />
                    ) : (
                      <span className={s.muted}>{strings.me.joinedOnNotSet}</span>
                    )
                  }
                  testId="own-joined"
                />
              </dl>
            </Card>
          </div>
          <div className={s.column} data-testid="own-right">
            <Card
              icon={<ShieldCheckmark20Regular />}
              title={strings.home.identityHeading}
              testId="own-identity"
            >
              <dl className={s.facts}>
                <Fact
                  label={strings.home.displayName}
                  value={<span data-testid="display-name">{identity.displayName}</span>}
                />
                <Fact
                  label={strings.home.userId}
                  value={
                    <Text className={s.mono} data-testid="user-id">
                      {identity.userId}
                    </Text>
                  }
                  copy={identity.userId}
                />
                <Fact
                  label={strings.home.safetyPhrase}
                  value={
                    <div className={s.words} data-testid="safety-phrase">
                      {identity.safetyPhrase.map((word, i) => (
                        <Badge key={i} appearance="tint" shape="rounded" size="large">
                          {word}
                        </Badge>
                      ))}
                    </div>
                  }
                />
                <Fact
                  label={strings.home.profile}
                  value={<span data-testid="profile-name">{info.profile}</span>}
                />
                <Fact
                  label={strings.home.keyProtection}
                  value={
                    <span data-testid="key-protection">
                      {strings.home.keyProtectionValue[info.keyProtection]}
                    </span>
                  }
                />
              </dl>
              <Text size={200} className={s.muted}>
                {strings.home.safetyPhraseHelp}
              </Text>
            </Card>

            <ContactCard email={identity.email} notes={identity.notes} />
          </div>
        </div>
      </div>
      {editing && <SettingsDialog initial="profile" onClose={() => setEditing(false)} />}
    </main>
  );
}
