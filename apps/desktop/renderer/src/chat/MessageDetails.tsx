/**
 * "Details" of a message: when it was sent, and for one you sent, when it reached each person and
 * when they saw it. In a group that is a list: who has it so far and who has seen it, with times.
 */
import { useEffect, useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  makeStyles,
  Text,
  tokens,
} from '@fluentui/react-components';
import type { MessageDetails as Details, MessageView } from '@officemesh/protocol/ipc';
import { exactTime } from '../format.ts';
import { core, displayName } from '../state.ts';
import { strings } from '../strings.ts';

const useStyles = makeStyles({
  surface: { width: '420px', maxWidth: 'calc(100vw - 32px)' },
  content: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM },
  facts: {
    display: 'grid',
    gridTemplateColumns: 'max-content 1fr',
    columnGap: tokens.spacingHorizontalL,
    rowGap: tokens.spacingVerticalXS,
    margin: 0,
    '& dt': { color: tokens.colorNeutralForeground3 },
    '& dd': { margin: 0 },
  },
  section: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalXXS },
  list: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: '2px',
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  row: { display: 'flex', justifyContent: 'space-between', columnGap: tokens.spacingHorizontalM },
  muted: { color: tokens.colorNeutralForeground3 },
});

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
  // The picture is kept up to date while it is open: a delivery or a read changes `status`.
  useEffect(() => {
    let live = true;
    void core
      .invoke('messages.details', { convId: m.convId, target: { author: m.author, seq: m.seq } })
      .then((d) => live && setDetails(d))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [m.convId, m.author, m.seq, m.status]);

  const recipients = details?.recipients;
  const delivered = recipients?.filter((r) => r.delivered) ?? [];
  const seen = recipients?.filter((r) => r.seen) ?? [];
  const waiting = (list: typeof delivered) =>
    (recipients ?? []).filter((r) => !list.includes(r)).map((r) => displayName(r.userId));
  const single = recipients?.length === 1;

  const when = (at: number | undefined) => (at !== undefined ? exactTime(at) : t.detailsNoTime);
  const person = (r: NonNullable<typeof recipients>[number], at: number | undefined) => (
    <li key={r.userId} className={styles.row} data-testid="details-person">
      <Text>{displayName(r.userId)}</Text>
      <Text className={styles.muted}>{when(at)}</Text>
    </li>
  );

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
                <dl className={styles.facts}>
                  {!m.mine && (
                    <>
                      <dt>{t.detailsFrom}</dt>
                      <dd>{displayName(m.author)}</dd>
                    </>
                  )}
                  <dt>{t.detailsSent}</dt>
                  <dd data-testid="details-sent">{exactTime(details.sentAt)}</dd>
                  {details.editedAt !== undefined && (
                    <>
                      <dt>{t.detailsEdited}</dt>
                      <dd data-testid="details-edited">{exactTime(details.editedAt)}</dd>
                    </>
                  )}
                  {single && recipients && (
                    <>
                      <dt>{t.detailsDelivered}</dt>
                      <dd data-testid="details-delivered">
                        {recipients[0]!.delivered
                          ? when(recipients[0]!.deliveredAt)
                          : t.detailsNotYet}
                      </dd>
                      <dt>{t.detailsSeen}</dt>
                      <dd data-testid="details-seen">
                        {recipients[0]!.seen ? when(recipients[0]!.seenAt) : t.detailsNotYet}
                      </dd>
                    </>
                  )}
                </dl>

                {recipients && !single && (
                  <>
                    <div className={styles.section} data-testid="details-delivered-list">
                      <Text weight="semibold">
                        {t.detailsDeliveredTo(delivered.length, recipients.length)}
                      </Text>
                      <ul className={styles.list}>
                        {delivered.map((r) => person(r, r.deliveredAt))}
                      </ul>
                      {waiting(delivered).length > 0 && (
                        <Text size={200} className={styles.muted}>
                          {t.detailsStillWaiting(waiting(delivered).join(', '))}
                        </Text>
                      )}
                    </div>
                    <div className={styles.section} data-testid="details-seen-list">
                      <Text weight="semibold">
                        {t.detailsSeenBy(seen.length, recipients.length)}
                      </Text>
                      <ul className={styles.list}>{seen.map((r) => person(r, r.seenAt))}</ul>
                      {waiting(seen).length > 0 && (
                        <Text size={200} className={styles.muted}>
                          {t.detailsStillWaiting(waiting(seen).join(', '))}
                        </Text>
                      )}
                    </div>
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
