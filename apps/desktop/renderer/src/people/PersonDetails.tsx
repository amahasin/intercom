/**
 * A colleague's page: the right-hand side of the People rail. Who they are, how to reach them (chat,
 * audio, video, remote help), their PC and InterCom version as they last reported them, and what
 * the two of you have done together.
 */
import { useEffect, useState, type ReactNode } from 'react';
import {
  Badge,
  Button,
  Menu,
  MenuDivider,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  mergeClasses,
  Text,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowDownLeft16Regular,
  ArrowUpRight16Regular,
  Call16Regular,
  Call20Regular,
  Chat16Regular,
  Chat20Regular,
  CheckmarkCircle20Filled,
  Copy16Regular,
  Delete20Regular,
  Document16Regular,
  History20Regular,
  MoreHorizontal20Regular,
  People20Regular,
  Person20Regular,
  ShieldCheckmark20Regular,
  ShieldError20Regular,
  Video16Regular,
  Video20Regular,
} from '@fluentui/react-icons';
import type { PersonActivity, PersonActivityItem, PersonView } from '@officemesh/protocol/ipc';
import { startCall } from '../calls/engine.ts';
import { messageTime, presenceBadge, presenceLine, presenceText, relativeAgo } from '../format.ts';
import { RemoteHelpButton } from '../remote/RemoteHelp.tsx';
import { EmptyPane } from '../shell/EmptyPane.tsx';
import { PresenceDot } from '../shell/PresenceDot.tsx';
import { core, nameOf, openChatWith, selectConversation, useApp } from '../state.ts';
import { strings } from '../strings.ts';
import { EnlargeablePicture } from './EnlargeablePicture.tsx';
import {
  Card,
  compareVersions,
  ContactCard,
  Fact,
  MachineCard,
  useFreshPerson,
  useProfileStyles,
  WorkplaceBadge,
} from './ProfileParts.tsx';
/** What the two of you have done together, kept up to date while the page is open. */
function useActivity(userId: string): PersonActivity | undefined {
  const [activity, setActivity] = useState<PersonActivity>();
  // New messages in their chat, and calls, change it.
  const lastActivity = useApp(
    (s) => Object.values(s.conversations).find((c) => c.peerUserId === userId)?.lastActivityAt,
  );
  const [calls, setCalls] = useState(0);
  useEffect(() => core.on('calls.history.changed', () => setCalls((n) => n + 1)), []);
  useEffect(() => {
    let live = true;
    void core
      .invoke('people.activity', { userId })
      .then((next) => live && setActivity(next))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [userId, lastActivity, calls]);
  return activity;
}

/** The right-hand side of the People rail. */
export function PersonDetails() {
  const id = useApp((s) => s.selectedPerson);
  const person = useApp((s) => (id ? s.people[id] : undefined));
  if (!person) return <EmptyPane rail="people" />;
  return <Page key={person.userId} person={person} />;
}

function Page({ person }: { person: PersonView }) {
  const s = useProfileStyles();
  const t = strings.personPage;
  const name = nameOf(person, person.userId);
  const activity = useActivity(person.userId);
  useFreshPerson(person.userId);
  const ownVersion = useApp((st) => st.info?.appVersion);
  const [phrase, setPhrase] = useState(person.trust === 'new-device');
  const update = async (change: { accept?: boolean; verified?: boolean }) => {
    const next = await core.invoke('people.setTrust', { userId: person.userId, ...change });
    useApp.setState((st) => ({ people: { ...st.people, [next.userId]: next } }));
  };
  const machine = person.machine;
  const versionNote =
    person.appVersion && ownVersion
      ? compareVersions(person.appVersion, ownVersion) === 0
        ? { text: t.sameVersion, color: 'success' as const }
        : compareVersions(person.appVersion, ownVersion) > 0
          ? { text: t.newerVersion, color: 'informative' as const }
          : { text: t.olderVersion, color: 'warning' as const }
      : undefined;
  const hours = activity ? Math.floor(activity.talkMs / 3_600_000) : 0;
  const minutes = activity ? Math.floor((activity.talkMs % 3_600_000) / 60_000) : 0;
  const tile = (label: string, value: string, note?: string, testId?: string) => (
    <div className={s.tile} data-testid={testId}>
      <Text size={600} weight="semibold" className={s.tileNumber}>
        {value}
      </Text>
      <Text size={200} className={s.muted}>
        {label}
        {note && ` · ${note}`}
      </Text>
    </div>
  );

  return (
    <section className={s.page} data-testid="person-page" aria-label={name}>
      <div className={s.inner}>
        <div className={s.hero}>
          <EnlargeablePicture
            name={name}
            avatarHash={person.avatarHash}
            size={96}
            badge={presenceBadge(person.presence)}
          />
          <div className={s.who}>
            <span className={s.nameLine}>
              <Text as="h2" size={700} weight="semibold" data-testid="person-name">
                {name}
              </Text>
              {person.verified && (
                <CheckmarkCircle20Filled
                  aria-label={strings.person.verified}
                  primaryFill={tokens.colorPaletteGreenForeground1}
                />
              )}
            </span>
            <Text
              size={400}
              className={person.jobTitle ? undefined : s.muted}
              data-testid="person-title"
            >
              {person.jobTitle ?? t.noJobTitle}
            </Text>
            <span className={s.presenceLine}>
              <PresenceDot state={person.presence} />
              <Text size={300} data-testid="person-presence">
                {presenceLine(person)}
              </Text>
            </span>
            {(person.workplace || (person.online && machine?.remote?.inUse)) && (
              <div className={s.badges}>
                <WorkplaceBadge workplace={person.workplace} />
                {person.online && machine?.remote?.inUse && (
                  <Badge
                    appearance="tint"
                    color="warning"
                    shape="rounded"
                    data-testid="person-remote-badge"
                  >
                    {t.remoteBadge}
                  </Badge>
                )}
              </div>
            )}
            {person.statusMessage && (
              <div className={s.quote} data-testid="person-status-message">
                <Text italic>{person.statusMessage}</Text>
              </div>
            )}
          </div>
        </div>

        <div className={s.actions}>
          <Button
            appearance="primary"
            icon={<Chat20Regular />}
            onClick={() => void openChatWith(person.userId)}
            data-testid="person-chat"
          >
            {t.chat}
          </Button>
          <Button
            icon={<Call20Regular />}
            disabled={!person.online}
            onClick={() => void startCall([person.userId], 'audio', activity?.convId)}
            data-testid="person-audio"
          >
            {t.audioCall}
          </Button>
          <Button
            icon={<Video20Regular />}
            disabled={!person.online}
            onClick={() => void startCall([person.userId], 'video', activity?.convId)}
            data-testid="person-video"
          >
            {t.videoCall}
          </Button>
          <RemoteHelpButton peer={person.userId} appearance="secondary" disabled={!person.online} />
          <Menu positioning="below-end">
            <MenuTrigger disableButtonEnhancement>
              <Button
                appearance="subtle"
                icon={<MoreHorizontal20Regular />}
                aria-label={t.more}
                data-testid="person-more-menu"
              />
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                {person.address && (
                  <MenuItem
                    icon={<Copy16Regular />}
                    onClick={() => void navigator.clipboard?.writeText(person.address!)}
                    data-testid="person-copy-ip"
                  >
                    {t.copyAddress}
                  </MenuItem>
                )}
                {machine && (
                  <MenuItem
                    icon={<Copy16Regular />}
                    onClick={() => void navigator.clipboard?.writeText(machine.host)}
                    data-testid="person-copy-host"
                  >
                    {t.copyComputer}
                  </MenuItem>
                )}
                <MenuItem
                  icon={<Copy16Regular />}
                  onClick={() => void navigator.clipboard?.writeText(person.userId)}
                  data-testid="person-copy-id"
                >
                  {t.copyId}
                </MenuItem>
                {!person.online && (
                  <>
                    <MenuDivider />
                    <MenuItem
                      icon={<Delete20Regular />}
                      onClick={() =>
                        void core
                          .invoke('people.hide', { userIds: [person.userId], hidden: true })
                          .then((changed) => {
                            useApp.setState((st) => ({
                              selectedPerson: undefined,
                              people: {
                                ...st.people,
                                ...Object.fromEntries(changed.map((p) => [p.userId, p])),
                              },
                            }));
                          })
                      }
                      data-testid="person-hide"
                    >
                      {t.removeFromList}
                    </MenuItem>
                  </>
                )}
              </MenuList>
            </MenuPopover>
          </Menu>
        </div>

        {person.trust === 'new-device' && (
          <MessageBar
            intent="warning"
            icon={<ShieldError20Regular />}
            data-testid="new-device-warning"
          >
            <MessageBarBody>{strings.person.unverifiedExplain(name)}</MessageBarBody>
            <MessageBarActions>
              <Button onClick={() => void update({ accept: true })} data-testid="accept-person">
                {strings.person.accept}
              </Button>
            </MessageBarActions>
          </MessageBar>
        )}

        <div className={s.columns}>
          <div className={s.column} data-testid="person-left">
            <MachineCard
              machine={machine}
              address={person.address}
              appVersion={person.appVersion}
              versionNote={versionNote}
              online={person.online}
              footnote={
                person.infoAt !== undefined ? t.reported(relativeAgo(person.infoAt)) : t.notReported
              }
            />

            <Card icon={<Person20Regular />} title={t.status} testId="person-status">
              <dl className={s.facts}>
                <Fact
                  label={t.availability}
                  value={
                    <>
                      <PresenceDot state={person.presence} />
                      {person.online ? presenceText(person) : strings.presence.offline}
                    </>
                  }
                />
                <Fact
                  label={strings.workplace.label}
                  value={
                    person.workplace ? (
                      strings.workplace.line[person.workplace]
                    ) : (
                      <span className={s.muted}>{t.unknown}</span>
                    )
                  }
                  testId="person-workplace"
                />
                <Fact
                  label={t.statusMessage}
                  value={
                    person.statusMessage ?? <span className={s.muted}>{t.noStatusMessage}</span>
                  }
                />
                <Fact
                  label={t.jobTitle}
                  value={person.jobTitle ?? <span className={s.muted}>{t.noJobTitle}</span>}
                />
                {!person.online && (
                  <Fact label={t.lastSeenLabel} value={relativeAgo(person.lastSeen)} />
                )}
                <Fact
                  label={t.knownSince}
                  value={new Date(person.firstSeen).toLocaleDateString(undefined, {
                    dateStyle: 'medium',
                  })}
                />
              </dl>
            </Card>

            <Card icon={<History20Regular />} title={t.activity} testId="person-activity">
              <div className={s.tiles}>
                {tile(
                  t.messages,
                  String(activity?.messages ?? 0),
                  undefined,
                  'person-stat-messages',
                )}
                {tile(t.files, String(activity?.files ?? 0), undefined, 'person-stat-files')}
                {tile(
                  t.calls,
                  String(activity?.calls ?? 0),
                  activity && activity.missedCalls > 0 ? t.missed(activity.missedCalls) : undefined,
                  'person-stat-calls',
                )}
                {tile(t.talkTime, t.hours(hours, minutes), undefined, 'person-stat-talk')}
              </div>
              {activity && activity.recent.length > 0 ? (
                <>
                  <Text weight="semibold" size={300}>
                    {t.recent}
                  </Text>
                  <div className={s.timeline} data-testid="person-recent">
                    {activity.recent.map((item, i) => (
                      <ActivityRow key={`${item.kind}-${item.at}-${i}`} item={item} name={name} />
                    ))}
                  </div>
                  {activity.convId && (
                    <Button
                      appearance="subtle"
                      size="small"
                      style={{ alignSelf: 'flex-start' }}
                      onClick={() => void selectConversation(activity.convId)}
                      data-testid="person-open-chat"
                    >
                      {t.openChat}
                    </Button>
                  )}
                </>
              ) : (
                <Text size={300} className={s.muted} data-testid="person-nothing">
                  {t.nothingYet}
                </Text>
              )}
              {activity?.firstContactAt !== undefined && (
                <Text size={200} className={s.muted}>
                  {t.firstContact(
                    new Date(activity.firstContactAt).toLocaleDateString(undefined, {
                      dateStyle: 'medium',
                    }),
                  )}
                </Text>
              )}
            </Card>
          </div>
          <div className={s.column} data-testid="person-right">
            <ContactCard email={person.email} notes={person.notes} />
            <Card icon={<People20Regular />} title={t.groups} testId="person-groups">
              {activity && activity.groups.length > 0 ? (
                <div className={s.chips}>
                  {activity.groups.map((g) => (
                    <Button
                      key={g.convId}
                      size="small"
                      shape="circular"
                      onClick={() => void selectConversation(g.convId)}
                    >
                      {g.title}
                    </Button>
                  ))}
                </div>
              ) : (
                <Text size={300} className={s.muted}>
                  {t.noGroups}
                </Text>
              )}
            </Card>

            <Card icon={<ShieldCheckmark20Regular />} title={t.identity} testId="person-identity">
              <Text size={300}>{person.verified ? t.identityVerified : t.identityPlain}</Text>
              <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
                <Button size="small" onClick={() => setPhrase(!phrase)} data-testid="verify-toggle">
                  {phrase ? t.hidePhrase : t.showPhrase}
                </Button>
                <Button
                  size="small"
                  onClick={() => void update({ verified: !person.verified })}
                  data-testid="toggle-verified"
                >
                  {person.verified ? strings.person.unmarkVerified : strings.person.markVerified}
                </Button>
              </div>
              {phrase && (
                <>
                  <div className={s.words} data-testid="peer-safety-phrase">
                    {person.safetyPhrase.map((w, i) => (
                      <Badge key={i} appearance="tint" shape="rounded">
                        {w}
                      </Badge>
                    ))}
                  </div>
                  <Text size={200} className={s.muted}>
                    {strings.person.safetyHelp}
                  </Text>
                </>
              )}
            </Card>
          </div>
        </div>
      </div>
    </section>
  );
}

function ActivityRow({ item, name }: { item: PersonActivityItem; name: string }) {
  const s = useProfileStyles();
  const t = strings.personPage;
  const who = item.mine ? t.you : name;
  const missed = item.kind === 'call' && item.outcome === 'missed';
  let icon: ReactNode;
  let line: string;
  let detail: string | undefined;
  if (item.kind === 'call') {
    icon = missed ? (
      <ArrowDownLeft16Regular />
    ) : item.mine ? (
      <ArrowUpRight16Regular />
    ) : item.media === 'video' ? (
      <Video16Regular />
    ) : (
      <Call16Regular />
    );
    line = t.callLine(item.mine, item.media === 'video');
    const outcome = item.outcome ? strings.calls.outcome[item.outcome] : '';
    detail =
      item.durationMs !== undefined && item.durationMs > 0
        ? strings.calls.duration(item.durationMs)
        : item.outcome !== 'completed'
          ? outcome
          : undefined;
  } else if (item.kind === 'file') {
    icon = <Document16Regular />;
    line = t.sentFile(who, item.text);
  } else {
    icon = <Chat16Regular />;
    line = `${who}: ${item.text}`;
  }
  return (
    <div className={s.item} data-testid="person-activity-item" data-kind={item.kind}>
      <span className={mergeClasses(s.itemIcon, missed && s.itemMissed)}>{icon}</span>
      <span className={s.itemText}>
        <Text className={s.ellipsis}>{line}</Text>
        {detail && (
          <Text size={200} className={mergeClasses(s.muted, s.ellipsis)}>
            {detail}
          </Text>
        )}
      </span>
      <Text size={200} className={s.muted}>
        {messageTime(item.at)}
      </Text>
    </div>
  );
}
