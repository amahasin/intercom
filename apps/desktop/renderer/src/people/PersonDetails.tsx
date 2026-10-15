/**
 * A colleague's page: the right-hand side of the People rail. Who they are, how to reach them (chat,
 * audio, video, remote help), their PC and InterCom version as they last reported them, and what
 * the two of you have done together.
 */
import { useEffect, useState, type ReactNode } from 'react';
import {
  Avatar,
  Badge,
  Button,
  makeStyles,
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
  Tooltip,
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
  Desktop20Regular,
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
import { messageTime, presenceBadge, presenceText, relativeAgo } from '../format.ts';
import { RemoteHelpButton } from '../remote/RemoteHelp.tsx';
import { EmptyPane } from '../shell/EmptyPane.tsx';
import { PresenceDot } from '../shell/PresenceDot.tsx';
import { avatarSrc, core, nameOf, openChatWith, selectConversation, useApp } from '../state.ts';
import { strings } from '../strings.ts';

const useStyles = makeStyles({
  page: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    background: tokens.colorNeutralBackground1,
  },
  inner: {
    maxWidth: '1040px',
    margin: '0 auto',
    padding: `${tokens.spacingVerticalXXL} ${tokens.spacingHorizontalXXL} ${tokens.spacingVerticalXXXL}`,
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalL,
  },
  hero: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalXL,
    padding: tokens.spacingHorizontalXL,
    borderRadius: tokens.borderRadiusXLarge,
    background: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  who: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalXXS, minWidth: 0 },
  nameLine: { display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalS },
  muted: { color: tokens.colorNeutralForeground3 },
  presenceLine: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalXS,
  },
  quote: {
    marginTop: tokens.spacingVerticalS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    borderLeft: `3px solid ${tokens.colorBrandStroke1}`,
    borderRadius: `0 ${tokens.borderRadiusMedium} ${tokens.borderRadiusMedium} 0`,
    background: tokens.colorNeutralBackground1,
    overflowWrap: 'anywhere',
  },
  actions: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
    gap: tokens.spacingHorizontalL,
    alignItems: 'start',
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalM,
    padding: tokens.spacingHorizontalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground1,
    minWidth: 0,
  },
  cardTitle: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground2,
  },
  facts: {
    display: 'grid',
    gridTemplateColumns: 'max-content 1fr',
    columnGap: tokens.spacingHorizontalXL,
    rowGap: tokens.spacingVerticalS,
    margin: 0,
    alignItems: 'center',
    '& dt': { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
    '& dd': {
      margin: 0,
      minWidth: 0,
      overflowWrap: 'anywhere',
      display: 'flex',
      alignItems: 'center',
      columnGap: tokens.spacingHorizontalXS,
      flexWrap: 'wrap',
    },
  },
  mono: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200 },
  tiles: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: tokens.spacingHorizontalS },
  tile: {
    display: 'flex',
    flexDirection: 'column',
    padding: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground2,
  },
  tileNumber: { fontVariantNumeric: 'tabular-nums' },
  timeline: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalXXS },
  item: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalXS}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  itemIcon: {
    flexShrink: 0,
    width: '28px',
    height: '28px',
    borderRadius: '50%',
    display: 'grid',
    placeItems: 'center',
    background: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2,
  },
  itemMissed: {
    background: tokens.colorPaletteRedBackground1,
    color: tokens.colorPaletteRedForeground1,
  },
  itemText: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' },
  ellipsis: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  chips: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS },
  words: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS },
});

/** Compare "0.16.2" with "0.15.1": positive when the first is newer. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

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

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <Tooltip content={done ? strings.personPage.copied : label} relationship="label">
      <Button
        size="small"
        appearance="subtle"
        icon={<Copy16Regular />}
        aria-label={label}
        onClick={() =>
          void navigator.clipboard
            ?.writeText(text)
            .then(() => setDone(true))
            .catch(() => {})
        }
        onMouseLeave={() => setDone(false)}
      />
    </Tooltip>
  );
}

function Card({
  icon,
  title,
  testId,
  children,
}: {
  icon: ReactNode;
  title: string;
  testId: string;
  children: ReactNode;
}) {
  const s = useStyles();
  return (
    <section className={s.card} data-testid={testId} aria-label={title}>
      <div className={s.cardTitle}>
        {icon}
        <Text weight="semibold" size={400}>
          {title}
        </Text>
      </div>
      {children}
    </section>
  );
}

/** The right-hand side of the People rail. */
export function PersonDetails() {
  const id = useApp((s) => s.selectedPerson);
  const person = useApp((s) => (id ? s.people[id] : undefined));
  if (!person) return <EmptyPane rail="people" />;
  return <Page key={person.userId} person={person} />;
}

function Page({ person }: { person: PersonView }) {
  const s = useStyles();
  const t = strings.personPage;
  const name = nameOf(person, person.userId);
  const activity = useActivity(person.userId);
  const ownVersion = useApp((st) => st.info?.appVersion);
  const [phrase, setPhrase] = useState(person.trust === 'new-device');
  const update = async (change: { accept?: boolean; verified?: boolean }) => {
    const next = await core.invoke('people.setTrust', { userId: person.userId, ...change });
    useApp.setState((st) => ({ people: { ...st.people, [next.userId]: next } }));
  };
  const machine = person.machine;
  const memory =
    machine?.memoryMb !== undefined
      ? machine.memoryMb >= 1024
        ? `${Math.round(machine.memoryMb / 1024)} GB`
        : `${machine.memoryMb} MB`
      : undefined;
  const versionNote =
    person.appVersion && ownVersion
      ? compareVersions(person.appVersion, ownVersion) === 0
        ? { text: t.sameVersion, color: 'success' as const }
        : compareVersions(person.appVersion, ownVersion) > 0
          ? { text: t.newerVersion, color: 'informative' as const }
          : { text: t.olderVersion, color: 'warning' as const }
      : undefined;
  const fact = (label: string, value: ReactNode | undefined, testId?: string, copy?: string) => (
    <>
      <dt>{label}</dt>
      <dd data-testid={testId}>
        {value ?? <span className={s.muted}>{t.unknown}</span>}
        {copy && value !== undefined && (
          <CopyButton text={copy} label={`${t.copy} ${label.toLowerCase()}`} />
        )}
      </dd>
    </>
  );

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
          <Avatar
            name={name}
            size={96}
            color="colorful"
            image={avatarSrc(person.avatarHash)}
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
                {person.online ? presenceText(person) : t.lastSeen(relativeAgo(person.lastSeen))}
              </Text>
            </span>
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

        <div className={s.grid}>
          <Card icon={<Desktop20Regular />} title={t.computer} testId="person-machine">
            <dl className={s.facts}>
              {fact(t.computerName, machine?.host, 'person-host', machine?.host)}
              {fact(
                t.ipAddress,
                person.address ? <span className={s.mono}>{person.address}</span> : undefined,
                'person-ip',
                person.address,
              )}
              {fact(t.os, machine?.os, 'person-os')}
              {fact(
                t.processor,
                machine?.cpu
                  ? `${machine.cpu}${machine.cores ? ` · ${t.cores(machine.cores)}` : ''}`
                  : undefined,
                'person-cpu',
              )}
              {fact(t.memory, memory, 'person-memory')}
              {fact(t.architecture, machine?.arch, 'person-arch')}
              {fact(
                t.version,
                person.appVersion ? (
                  <>
                    <span className={s.mono}>{person.appVersion}</span>
                    {versionNote && (
                      <Badge appearance="tint" shape="rounded" color={versionNote.color}>
                        {versionNote.text}
                      </Badge>
                    )}
                  </>
                ) : undefined,
                'person-version',
              )}
            </dl>
            {person.infoAt !== undefined ? (
              <Text size={200} className={s.muted}>
                {t.reported(relativeAgo(person.infoAt))}
              </Text>
            ) : (
              <Text size={200} className={s.muted}>
                {t.notReported}
              </Text>
            )}
          </Card>

          <Card icon={<Person20Regular />} title={t.status} testId="person-status">
            <dl className={s.facts}>
              {fact(
                t.availability,
                <>
                  <PresenceDot state={person.presence} />
                  {person.online ? presenceText(person) : strings.presence.offline}
                </>,
              )}
              {fact(
                t.statusMessage,
                person.statusMessage ?? <span className={s.muted}>{t.noStatusMessage}</span>,
              )}
              {fact(t.jobTitle, person.jobTitle ?? <span className={s.muted}>{t.noJobTitle}</span>)}
              {!person.online && fact(t.lastSeenLabel, relativeAgo(person.lastSeen))}
              {fact(
                t.knownSince,
                new Date(person.firstSeen).toLocaleDateString(undefined, { dateStyle: 'medium' }),
              )}
            </dl>
          </Card>

          <Card icon={<History20Regular />} title={t.activity} testId="person-activity">
            <div className={s.tiles}>
              {tile(t.messages, String(activity?.messages ?? 0), undefined, 'person-stat-messages')}
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

          <div
            style={{ display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalL }}
          >
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
  const s = useStyles();
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
