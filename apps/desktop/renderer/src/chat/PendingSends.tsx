import { useMemo } from 'react';
import {
  Button,
  makeStyles,
  mergeClasses,
  ProgressBar,
  Text,
  tokens,
} from '@fluentui/react-components';
import { ArrowClockwise16Regular, Dismiss16Regular } from '@fluentui/react-icons';
import type { MsgRef } from '@officemesh/protocol';
import { formatSize, messageTime } from '../format.ts';
import { FileIcon } from '../preview/FileIcon.tsx';
import { previewKind } from '../preview/kinds.ts';
import { strings } from '../strings.ts';
import { composerKey, useAttachments } from './attachments.ts';
import { Markdown } from './Markdown.tsx';
import { dismissSend, retrySend, useOutbox, type PendingSend } from './outbox.ts';

const useStyles = makeStyles({
  row: { display: 'flex', justifyContent: 'flex-end', padding: '2px 0' },
  postRow: { justifyContent: 'flex-start', padding: `2px ${tokens.spacingHorizontalM}` },
  stack: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    maxWidth: '90%',
    minWidth: 0,
  },
  postStack: { alignItems: 'flex-start', maxWidth: '100%', flex: 1 },
  head: {
    marginBottom: '2px',
    color: tokens.colorNeutralForeground3,
    whiteSpace: 'nowrap',
  },
  bubble: {
    maxWidth: '100%',
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusLarge,
    background: tokens.colorBrandBackground2,
    userSelect: 'text',
  },
  postBubble: {
    background: 'transparent',
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
  },
  card: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalM,
    boxSizing: 'border-box',
    width: '100%',
    minWidth: '280px',
    maxWidth: '420px',
    marginTop: tokens.spacingVerticalXS,
    padding: tokens.spacingHorizontalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
  },
  text: { display: 'flex', flexDirection: 'column', rowGap: '2px', minWidth: 0, flex: 1 },
  name: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  muted: { color: tokens.colorNeutralForeground3 },
  danger: { color: tokens.colorPaletteRedForeground1 },
  actions: { display: 'flex', columnGap: tokens.spacingHorizontalXS, flexShrink: 0 },
  imageWrap: {
    position: 'relative',
    display: 'inline-block',
    marginTop: tokens.spacingVerticalXS,
    maxWidth: '100%',
  },
  image: {
    display: 'block',
    maxWidth: '360px',
    maxHeight: '320px',
    width: 'auto',
    height: 'auto',
    objectFit: 'contain',
    borderRadius: tokens.borderRadiusMedium,
    opacity: 0.6,
  },
  overlay: {
    position: 'absolute',
    insetInline: tokens.spacingHorizontalM,
    bottom: tokens.spacingVerticalM,
    display: 'flex',
    flexDirection: 'column',
    rowGap: '2px',
    padding: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
});

/** "Preparing the file · 49%", or what is the matter. */
function statusLine(p: PendingSend, fraction: number | undefined): string {
  if (p.state === 'failed') return `${strings.outbox.notSent}: ${p.error ?? ''}`.trim();
  if (p.state === 'waiting') return strings.outbox.waiting;
  return fraction === undefined
    ? strings.outbox.preparing
    : strings.outbox.preparingPct(Math.floor(fraction * 100));
}

function Pending({ p, post }: { p: PendingSend; post: boolean }) {
  const s = useStyles();
  const prep = useAttachments((st) => st.preparing[p.id]);
  const fraction = prep && prep.total > 0 ? Math.min(1, prep.done / prep.total) : undefined;
  const a = p.attachment;
  const failed = p.state === 'failed';
  const line = statusLine(p, fraction);
  const bar = !failed && (
    <ProgressBar
      thickness="medium"
      {...(p.state === 'preparing' && fraction !== undefined && { value: fraction })}
      {...(p.state === 'waiting' && { value: 0 })}
    />
  );
  const buttons = failed && (
    <div className={s.actions}>
      <Button
        size="small"
        icon={<ArrowClockwise16Regular />}
        onClick={() => retrySend(p.id)}
        data-testid="pending-retry"
      >
        {strings.outbox.retry}
      </Button>
      <Button
        size="small"
        appearance="subtle"
        icon={<Dismiss16Regular />}
        aria-label={`${strings.outbox.remove}: ${a.name}`}
        onClick={() => dismissSend(p.id)}
        data-testid="pending-dismiss"
      />
    </div>
  );

  return (
    <div className={mergeClasses(s.row, post && s.postRow)}>
      <div className={mergeClasses(s.stack, post && s.postStack)}>
        <Text size={200} className={s.head} data-testid="pending-time">
          {messageTime(p.at)}
        </Text>
        <div
          className={mergeClasses(s.bubble, post && s.postBubble)}
          data-testid="pending-send"
          data-state={p.state}
          data-name={a.name}
        >
          {p.text && <Markdown text={p.text} />}
          {a.previewUrl ? (
            <div className={s.imageWrap}>
              <img className={s.image} src={a.previewUrl} alt={a.name} />
              <div className={s.overlay}>
                <Text
                  size={200}
                  className={failed ? s.danger : s.muted}
                  data-testid="pending-status"
                >
                  {line}
                </Text>
                {bar}
                {buttons}
              </div>
            </div>
          ) : (
            <div className={s.card}>
              <FileIcon kind={previewKind({ name: a.name, mime: a.mime })} />
              <div className={s.text}>
                <Text weight="semibold" className={s.name} title={a.name}>
                  {a.name}
                </Text>
                <Text size={200} className={s.muted}>
                  {formatSize(a.size)}
                </Text>
                <Text
                  size={200}
                  className={failed ? s.danger : s.muted}
                  data-testid="pending-status"
                >
                  {line}
                </Text>
                {bar}
              </div>
              {buttons}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Files that were just sent from this composer and are still being prepared, at the end of the
 * conversation (or of the channel thread) as messages of their own. Each is replaced by the real
 * message as soon as the core has made it.
 */
export function PendingSends({
  convId,
  thread,
  post = false,
}: {
  convId: string;
  thread?: MsgRef | undefined;
  /** Channel posts and replies, which are full-width and left-aligned. */
  post?: boolean;
}) {
  const key = composerKey(convId, thread);
  const items = useOutbox((s) => s.items);
  const mine = useMemo(() => items.filter((p) => p.key === key), [items, key]);
  if (mine.length === 0) return null;
  return (
    <div data-testid="pending-sends">
      {mine.map((p) => (
        <Pending key={p.id} p={p} post={post} />
      ))}
    </div>
  );
}
