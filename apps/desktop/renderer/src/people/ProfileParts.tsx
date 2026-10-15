/**
 * The pieces a colleague's page and your own page (the welcome page) have in common: the layout,
 * a card, a labelled fact, and the blocks that say how to reach the person, what their PC is and
 * whether somebody is using it through Remote Desktop.
 */
import { useState, type ReactNode } from 'react';
import { Badge, Button, makeStyles, Text, tokens, Tooltip } from '@fluentui/react-components';
import {
  Building16Regular,
  Copy16Regular,
  Desktop20Regular,
  Home16Regular,
  Mail20Regular,
} from '@fluentui/react-icons';
import type { MachineInfo } from '@officemesh/protocol';
import { strings } from '../strings.ts';

export const useProfileStyles = makeStyles({
  page: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    background: tokens.colorNeutralBackground1,
    userSelect: 'text',
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
  stack: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalL },
  // Two columns of cards, each a stack of its own: a tall card moves only the cards under it, never
  // the ones beside it.
  columns: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
    gap: tokens.spacingHorizontalL,
    alignItems: 'start',
  },
  column: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalL,
    minWidth: 0,
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
  notes: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  remoteOn: {
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorPaletteDarkOrangeBackground2,
    color: tokens.colorPaletteDarkOrangeForeground2,
  },
  pictureButton: {
    border: 'none',
    background: 'transparent',
    padding: 0,
    borderRadius: '50%',
    cursor: 'zoom-in',
    display: 'inline-flex',
  },
});

/** Compare "0.16.2" with "0.15.1": positive when the first is newer. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function formatMemory(memoryMb: number | undefined): string | undefined {
  if (memoryMb === undefined) return undefined;
  return memoryMb >= 1024 ? `${Math.round(memoryMb / 1024)} GB` : `${memoryMb} MB`;
}

/** Where someone is working today, as a small badge: In the office, or Working from home. */
export function WorkplaceBadge({ workplace }: { workplace: 'office' | 'home' | undefined }) {
  if (!workplace) return null;
  return (
    <Badge
      appearance="tint"
      shape="rounded"
      color={workplace === 'home' ? 'brand' : 'informative'}
      icon={workplace === 'home' ? <Home16Regular /> : <Building16Regular />}
      data-testid="workplace-badge"
      data-workplace={workplace}
    >
      {strings.workplace.line[workplace]}
    </Badge>
  );
}

/** An address that is safe to hand to the mail program as a link (nothing that could add a header). */
const LINKABLE_EMAIL = /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/;

export function CopyButton({ text, label }: { text: string; label: string }) {
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

export function Card({
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
  const s = useProfileStyles();
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

/** One labelled row of a card's facts; `value` undefined reads "Unknown". */
export function Fact({
  label,
  value,
  testId,
  copy,
}: {
  label: string;
  value: ReactNode | undefined;
  testId?: string;
  copy?: string | undefined;
}) {
  const s = useProfileStyles();
  return (
    <>
      <dt>{label}</dt>
      <dd data-testid={testId}>
        {value ?? <span className={s.muted}>{strings.personPage.unknown}</span>}
        {copy && value !== undefined && (
          <CopyButton text={copy} label={`${strings.personPage.copy} ${label.toLowerCase()}`} />
        )}
      </dd>
    </>
  );
}

/** How to reach the person outside InterCom: their email, and whatever they wrote for colleagues. */
export function ContactCard({
  email,
  notes,
}: {
  email?: string | undefined;
  notes?: string | undefined;
}) {
  const s = useProfileStyles();
  const t = strings.personPage;
  return (
    <Card icon={<Mail20Regular />} title={t.contact} testId="person-contact">
      <dl className={s.facts}>
        <Fact
          label={t.email}
          testId="person-email"
          copy={email}
          value={
            email ? (
              LINKABLE_EMAIL.test(email) ? (
                <a href={`mailto:${email}`}>{email}</a>
              ) : (
                email
              )
            ) : (
              <span className={s.muted}>{t.noEmail}</span>
            )
          }
        />
        <Fact
          label={t.notes}
          testId="person-notes"
          value={
            notes ? (
              <span className={s.notes}>{notes}</span>
            ) : (
              <span className={s.muted}>{t.noNotes}</span>
            )
          }
        />
      </dl>
    </Card>
  );
}

/** What is said about Remote Desktop use of a PC: in use (from where), left open, or nobody. */
export function remoteDesktopText(remote: NonNullable<MachineInfo['remote']>): {
  text: string;
  inUse: boolean;
} {
  const t = strings.personPage;
  const active = remote.sessions.find((x) => x.state === 'active');
  const left = remote.sessions.find((x) => x.state === 'disconnected');
  if (active)
    return { text: t.remoteActive(t.remoteFrom(active.client, active.address)), inUse: true };
  if (left)
    return { text: t.remoteLeftOpen(t.remoteFrom(left.client, left.address)), inUse: false };
  return { text: t.remoteNone, inUse: false };
}

/**
 * The computer card: name, address, system, hardware, InterCom's version and Remote Desktop use.
 * `online` false says the facts are from when the PC was last seen.
 */
export function MachineCard({
  machine,
  address,
  appVersion,
  versionNote,
  footnote,
  online = true,
}: {
  machine: MachineInfo | undefined;
  address: string | undefined;
  appVersion: string | undefined;
  versionNote?: { text: string; color: 'success' | 'informative' | 'warning' } | undefined;
  footnote?: string | undefined;
  online?: boolean;
}) {
  const s = useProfileStyles();
  const t = strings.personPage;
  const remote = machine?.remote ? remoteDesktopText(machine.remote) : undefined;
  return (
    <Card icon={<Desktop20Regular />} title={t.computer} testId="person-machine">
      <dl className={s.facts}>
        <Fact
          label={t.computerName}
          value={machine?.host}
          testId="person-host"
          copy={machine?.host}
        />
        <Fact
          label={t.ipAddress}
          value={address ? <span className={s.mono}>{address}</span> : undefined}
          testId="person-ip"
          copy={address}
        />
        <Fact label={t.os} value={machine?.os} testId="person-os" />
        <Fact
          label={t.processor}
          value={
            machine?.cpu
              ? `${machine.cpu}${machine.cores ? ` · ${t.cores(machine.cores)}` : ''}`
              : undefined
          }
          testId="person-cpu"
        />
        <Fact label={t.memory} value={formatMemory(machine?.memoryMb)} testId="person-memory" />
        <Fact label={t.architecture} value={machine?.arch} testId="person-arch" />
        <Fact
          label={t.version}
          testId="person-version"
          value={
            appVersion ? (
              <>
                <span className={s.mono}>{appVersion}</span>
                {versionNote && (
                  <Badge appearance="tint" shape="rounded" color={versionNote.color}>
                    {versionNote.text}
                  </Badge>
                )}
              </>
            ) : undefined
          }
        />
        <Fact
          label={t.remote}
          testId="person-remote-desktop"
          value={
            remote ? (
              <span
                className={remote.inUse ? s.remoteOn : undefined}
                data-in-use={remote.inUse}
                data-testid="person-remote-text"
              >
                {remote.text}
                {!online && ` ${t.remoteOffline}`}
              </span>
            ) : (
              <span className={s.muted}>{t.remoteNotReported}</span>
            )
          }
        />
      </dl>
      {footnote && (
        <Text size={200} className={s.muted}>
          {footnote}
        </Text>
      )}
    </Card>
  );
}
