/**
 * "Details" of a message: when it was sent, and for one you sent, when it reached each person and
 * when they saw it. In a group that is a list: who has it so far and who has seen it, with times.
 */
import { useEffect, useState, type ReactNode } from 'react';
import {
  Avatar,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  makeStyles,
  mergeClasses,
  ProgressBar,
  Text,
  tokens,
} from '@fluentui/react-components';
import {
  CheckmarkCircle20Filled,
  Edit20Regular,
  Eye20Filled,
  Eye20Regular,
  Person20Regular,
  Send20Regular,
} from '@fluentui/react-icons';
import type { MessageDetails as Details, MessageView } from '@officemesh/protocol/ipc';
import { exactTime } from '../format.ts';
import { avatarSrc, core, displayName, useApp } from '../state.ts';
import { strings } from '../strings.ts';

const useStyles = makeStyles({
  surface: { width: '460px', maxWidth: 'calc(100vw - 32px)' },
  content: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM },
  // When it was sent (and edited, and by whom): a quiet panel at the top.
  summary: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalS,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}`,
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusLarge,
  },
  fact: { display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalM },
  factIcon: {
    flexShrink: 0,
    width: '32px',
    height: '32px',
    display: 'grid',
    placeItems: 'center',
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground2,
    boxShadow: tokens.shadow2,
  },
  factText: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  label: { color: tokens.colorNeutralForeground3 },
  // Delivered and Seen as two steps, each with its own colour: done, or not yet.
  steps: { display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: tokens.spacingHorizontalM },
  step: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalXS,
    padding: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusLarge,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  stepHead: { display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalXS },
  delivered: { color: tokens.colorPaletteGreenForeground1 },
  seenColor: { color: tokens.colorBrandForeground1 },
  pending: { color: tokens.colorNeutralForeground4 },
  section: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalS,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}`,
    borderRadius: tokens.borderRadiusLarge,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  sectionHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: tokens.spacingHorizontalM,
  },
  sectionTitle: { display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalS },
  // A long list (the Broadcast channel) scrolls inside its panel instead of growing the dialog.
  list: {
    display: 'flex',
    flexDirection: 'column',
    margin: 0,
    padding: 0,
    listStyle: 'none',
    maxHeight: '196px',
    overflowY: 'auto',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalXS}`,
    borderRadius: tokens.borderRadiusMedium,
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
  },
  rowName: {
    flexGrow: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  time: { color: tokens.colorNeutralForeground3, fontVariantNumeric: 'tabular-nums' },
  waiting: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    paddingTop: tokens.spacingVerticalXS,
    borderTop: `${tokens.strokeWidthThin} dashed ${tokens.colorNeutralStroke2}`,
  },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalXS,
    padding: `2px ${tokens.spacingHorizontalS} 2px 2px`,
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2,
  },
  muted: { color: tokens.colorNeutralForeground3 },
});

/** A colleague's picture, small, the way it is shown elsewhere (initials until there is one). */
function Face({ userId, size }: { userId: string; size: 20 | 28 }) {
  const person = useApp((st) => st.people[userId]);
  return <Avatar size={size} name={displayName(userId)} image={avatarSrc(person?.avatarHash)} />;
}

export function MessageDetailsDialog({
  message: m,
  onClose,
}: {
  message: MessageView;
  onClose: () => void;
}) {
  const styles = useStyles();
  const t = strings.message;
  const [details, setDetails] = useState<Details>();
  const [failed, setFailed] = useState(false);
  // The picture is kept up to date while it is open: a delivery or a read changes `status`, and in
  // a group a message is "delivered" or "seen" for everyone only when the last one has it, so the
  // people in between are looked at again every few seconds.
  useEffect(() => {
    let live = true;
    const look = () =>
      void core
        .invoke('messages.details', { convId: m.convId, target: { author: m.author, seq: m.seq } })
        .then((d) => live && setDetails(d))
        .catch(() => live && setFailed(true));
    look();
    const timer = setInterval(look, 3_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [m.convId, m.author, m.seq, m.status]);

  const recipients = details?.recipients;
  const delivered = recipients?.filter((r) => r.delivered) ?? [];
  const seen = recipients?.filter((r) => r.seen) ?? [];
  const single = recipients?.length === 1;

  const when = (at: number | undefined) => (at !== undefined ? exactTime(at) : t.detailsNoTime);
  /** In a list the day is the same for nearly everyone: the time alone says enough. */
  const rowTime = (at: number | undefined) => {
    if (at === undefined) return t.detailsNoTime;
    if (!details || new Date(at).toDateString() !== new Date(details.sentAt).toDateString())
      return exactTime(at);
    return new Date(at).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const fact = (icon: ReactNode, label: string, value: ReactNode, testId?: string) => (
    <div className={styles.fact}>
      <span className={styles.factIcon}>{icon}</span>
      <span className={styles.factText}>
        <Text size={200} className={styles.label}>
          {label}
        </Text>
        <Text weight="semibold" data-testid={testId}>
          {value}
        </Text>
      </span>
    </div>
  );

  const step = (
    kind: 'delivered' | 'seen',
    done: boolean,
    at: number | undefined,
    testId: string,
  ) => (
    <div className={styles.step}>
      <span
        className={mergeClasses(
          styles.stepHead,
          done ? (kind === 'delivered' ? styles.delivered : styles.seenColor) : styles.pending,
        )}
      >
        {kind === 'delivered' ? (
          <CheckmarkCircle20Filled />
        ) : done ? (
          <Eye20Filled />
        ) : (
          <Eye20Regular />
        )}
        <Text size={200} weight="semibold">
          {kind === 'delivered' ? t.detailsDelivered : t.detailsSeen}
        </Text>
      </span>
      <Text className={done ? undefined : styles.muted} data-testid={testId}>
        {done ? when(at) : t.detailsNotYet}
      </Text>
    </div>
  );

  const section = (
    kind: 'delivered' | 'seen',
    title: string,
    list: NonNullable<typeof recipients>,
    all: NonNullable<typeof recipients>,
    time: (r: (typeof list)[number]) => number | undefined,
    testId: string,
  ) => {
    const missing = all.filter((r) => !list.includes(r));
    const color = kind === 'delivered' ? styles.delivered : styles.seenColor;
    return (
      <div className={styles.section} data-testid={testId}>
        <div className={styles.sectionHead}>
          <span className={mergeClasses(styles.sectionTitle, color)}>
            {kind === 'delivered' ? <CheckmarkCircle20Filled /> : <Eye20Filled />}
            <Text weight="semibold">{title}</Text>
          </span>
        </div>
        <ProgressBar
          value={list.length}
          max={Math.max(all.length, 1)}
          thickness="medium"
          color={kind === 'delivered' ? 'success' : 'brand'}
          aria-label={title}
        />
        {list.length > 0 && (
          <ul className={styles.list}>
            {list.map((r) => (
              <li key={r.userId} className={styles.row} data-testid="details-person">
                <Face userId={r.userId} size={28} />
                <Text className={styles.rowName}>{displayName(r.userId)}</Text>
                <Text size={200} className={styles.time}>
                  {rowTime(time(r))}
                </Text>
              </li>
            ))}
          </ul>
        )}
        {missing.length > 0 && (
          <div className={styles.waiting} data-testid="details-not-yet">
            <Text size={200} className={styles.muted}>
              {t.detailsNotYet}
            </Text>
            {missing.map((r) => (
              <span key={r.userId} className={styles.chip}>
                <Face userId={r.userId} size={20} />
                <Text size={200}>{displayName(r.userId)}</Text>
              </span>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <Dialog open onOpenChange={(_e, d) => !d.open && onClose()}>
      <DialogSurface className={styles.surface} data-testid="message-details">
        <DialogBody>
          <DialogTitle>{t.detailsTitle}</DialogTitle>
          <DialogContent className={styles.content}>
            {failed && <Text>{t.detailsFailed}</Text>}
            {!details && !failed && <Text className={styles.muted}>{t.detailsLoading}</Text>}
            {details && (
              <>
                <div className={styles.summary}>
                  {!m.mine && fact(<Person20Regular />, t.detailsFrom, displayName(m.author))}
                  {fact(
                    <Send20Regular />,
                    t.detailsSent,
                    exactTime(details.sentAt),
                    'details-sent',
                  )}
                  {details.editedAt !== undefined &&
                    fact(
                      <Edit20Regular />,
                      t.detailsEdited,
                      exactTime(details.editedAt),
                      'details-edited',
                    )}
                </div>

                {single && recipients && (
                  <div className={styles.steps}>
                    {step(
                      'delivered',
                      recipients[0]!.delivered,
                      recipients[0]!.deliveredAt,
                      'details-delivered',
                    )}
                    {step('seen', recipients[0]!.seen, recipients[0]!.seenAt, 'details-seen')}
                  </div>
                )}

                {recipients && !single && (
                  <>
                    {section(
                      'delivered',
                      t.detailsDeliveredTo(delivered.length, recipients.length),
                      delivered,
                      recipients,
                      (r) => r.deliveredAt,
                      'details-delivered-list',
                    )}
                    {section(
                      'seen',
                      t.detailsSeenBy(seen.length, recipients.length),
                      seen,
                      recipients,
                      (r) => r.seenAt,
                      'details-seen-list',
                    )}
                  </>
                )}

                {!recipients && (
                  <Text size={200} className={styles.muted}>
                    {t.detailsOthers}
                  </Text>
                )}
              </>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" onClick={onClose} data-testid="message-details-close">
              {t.detailsClose}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
