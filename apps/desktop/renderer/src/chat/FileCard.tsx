import { useEffect } from 'react';
import {
  Button,
  makeStyles,
  mergeClasses,
  ProgressBar,
  Text,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowDownload20Regular,
  Document24Regular,
  DocumentDismiss24Regular,
  Folder24Regular,
} from '@fluentui/react-icons';
import { FOLDER_MIME, type FileRef } from '@officemesh/protocol';
import type { FileStatus, FileUpload } from '@officemesh/protocol/ipc';
import { formatSize } from '../format.ts';
import { PreviewCard } from '../preview/PreviewCard.tsx';
import { previewKind } from '../preview/kinds.ts';
import { openFile } from '../preview/store.ts';
import { core, displayName, mergeFileStatuses, useApp, watchFile } from '../state.ts';
import { strings } from '../strings.ts';

const useStyles = makeStyles({
  card: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalM,
    marginTop: tokens.spacingVerticalXS,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    width: '100%',
    maxWidth: '420px',
    boxSizing: 'border-box',
  },
  missing: { background: tokens.colorNeutralBackground3 },
  top: { display: 'flex', alignItems: 'flex-start', columnGap: tokens.spacingHorizontalM },
  icon: { flexShrink: 0, color: tokens.colorNeutralForeground2 },
  text: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, rowGap: '2px' },
  name: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  muted: { color: tokens.colorNeutralForeground3 },
  danger: { color: tokens.colorPaletteRedForeground1 },
  line: { display: 'flex', flexDirection: 'column', rowGap: '2px', marginTop: '2px' },
  actions: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS },
  imageWrap: { position: 'relative', display: 'inline-block', marginTop: tokens.spacingVerticalXS },
  image: {
    display: 'block',
    maxWidth: '360px',
    maxHeight: '320px',
    width: 'auto',
    height: 'auto',
    objectFit: 'contain',
    borderRadius: tokens.borderRadiusMedium,
    cursor: 'pointer',
  },
  dim: { filter: 'grayscale(1)', opacity: 0.45 },
  overlay: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    rowGap: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    background: 'rgb(0 0 0 / 0.28)',
    color: '#fff',
    padding: tokens.spacingHorizontalM,
    boxSizing: 'border-box',
    textAlign: 'center',
  },
  overlayBar: { width: '70%' },
});

export { formatSize };

export const formatSpeed = (bytesPerSecond: number) => `${formatSize(bytesPerSecond)}/s`;

/** "8 s left", "2 min left", "1 h 5 min left". */
export function formatEta(seconds: number): string {
  if (seconds < 1) return strings.files.almostDone;
  if (seconds < 60) return strings.files.timeLeft(`${seconds} s`);
  if (seconds < 3600) return strings.files.timeLeft(`${Math.ceil(seconds / 60)} min`);
  const h = Math.floor(seconds / 3600);
  const m = Math.ceil((seconds % 3600) / 60);
  return strings.files.timeLeft(m === 60 ? `${h + 1} h` : `${h} h ${m} min`);
}

const toBase64 = (b64url: string) => b64url.replace(/-/g, '+').replace(/_/g, '/');

/** "45% · 82 MB/s · 2 min left", for a download or an upload. */
export function transferText(
  fraction: number,
  speed: number | undefined,
  eta: number | null | undefined,
): string {
  const parts = [`${Math.floor(Math.min(1, fraction) * 100)}%`];
  if (speed !== undefined && speed > 0) parts.push(formatSpeed(speed));
  if (eta !== undefined && eta !== null && speed) parts.push(formatEta(eta));
  else if (speed === 0) parts.push(strings.files.stalled);
  return parts.join(' · ');
}

function useFileState(sha: string): FileStatus | undefined {
  const status = useApp((s) => s.files[sha]);
  // While this card is on screen, notice a file that was deleted (or comes back).
  useEffect(() => watchFile(sha), [sha]);
  return status;
}

function UploadLines({ uploads }: { uploads: FileUpload[] }) {
  const styles = useStyles();
  const shown = uploads.slice(0, 3);
  return (
    <div className={styles.line} data-testid="file-uploads">
      {shown.map((u) => (
        <div key={u.userId} data-testid="file-upload" data-user={u.userId}>
          <Text size={200} className={styles.muted}>
            {strings.files.sendingTo(displayName(u.userId))} ·{' '}
            {transferText(u.sent / u.total, u.bytesPerSecond, u.etaSeconds)}
          </Text>
          <ProgressBar value={Math.min(1, u.sent / u.total)} thickness="medium" />
        </div>
      ))}
      {uploads.length > shown.length && (
        <Text size={200} className={styles.muted}>
          {strings.files.sendingToMore(uploads.length - shown.length)}
        </Text>
      )}
    </div>
  );
}

/** "Waiting for Asha to come online": the file goes the moment they are back. */
function QueuedLine({ text }: { text: string }) {
  const styles = useStyles();
  return (
    <Text size={200} className={styles.muted} data-testid="file-queued">
      {text}
    </Text>
  );
}

function download(sha: string): void {
  void core.invoke('files.download', { sha256: sha }).then((st) => mergeFileStatuses([st]));
}

/**
 * A shared file. A picture shows itself (its small preview until it is saved, the full
 * picture after); anything else is a card with its state: not saved, downloading with
 * speed and time left, saved, or missing because the file was deleted.
 */
export function FileCard({
  file,
  mine = false,
  onShare,
  queued,
}: {
  file: FileRef;
  mine?: boolean;
  /** Why the file has not gone yet ("Waiting for Asha to come online"), on a file you sent. */
  queued?: string | undefined;
  /** Forward the message this file came in (the card shows a Forward button when given). */
  onShare?: () => void;
}) {
  const styles = useStyles();
  const status = useFileState(file.sha256);
  const uploads = useApp((s) => s.uploads[file.sha256]);
  const state = status?.state ?? 'missing';
  const isImage = /^image\/(png|jpeg|gif|webp|bmp|svg\+xml)$/.test(file.mime);
  const kind = previewKind(file);
  // Pictures and the other kinds the viewer shows open in it; anything else in the PC's own app.
  const open = () => openFile(file);
  const pct = status && status.size > 0 ? status.received / status.size : 0;
  const downloading = state === 'downloading';
  // A folder that was sent: shown as one transfer, opened as one folder.
  const folder = file.mime === FOLDER_MIME;
  // A folder's size is what is in it (the file in the message is only its index).
  const total = folder && file.folder ? file.folder.bytes : file.size;

  if (isImage && state !== 'gone' && (state === 'complete' || file.thumb)) {
    if (state === 'complete') {
      return (
        <div className={styles.imageWrap}>
          <img
            className={styles.image}
            src={`./files/${file.sha256}?type=${encodeURIComponent(file.mime)}`}
            alt={file.name}
            onClick={open}
            data-testid="inline-image"
            data-state={state}
          />
          {uploads && uploads.length > 0 && <UploadLines uploads={uploads} />}
          {queued && <QueuedLine text={queued} />}
        </div>
      );
    }
    // Not saved yet: the preview, with a click-to-save overlay (or progress while saving).
    return (
      <div className={styles.imageWrap}>
        <img
          className={styles.image}
          src={`data:image/jpeg;base64,${toBase64(file.thumb!)}`}
          alt={file.name}
          onClick={downloading ? undefined : () => download(file.sha256)}
          data-testid="inline-image"
          data-state={state}
        />
        {downloading ? (
          <div className={styles.overlay}>
            <Text size={200} style={{ color: '#fff' }} data-testid="file-progress">
              {transferText(pct, status?.bytesPerSecond, status?.etaSeconds)}
            </Text>
            <ProgressBar className={styles.overlayBar} value={pct} thickness="large" />
          </div>
        ) : (
          <div
            className={styles.overlay}
            role="button"
            tabIndex={0}
            onClick={() => download(file.sha256)}
            onKeyDown={(e) => e.key === 'Enter' && download(file.sha256)}
            data-testid="file-download"
          >
            <ArrowDownload20Regular />
            <Text size={200} style={{ color: '#fff' }}>
              {strings.files.saveImage(formatSize(file.size))}
            </Text>
          </div>
        )}
        {uploads && uploads.length > 0 && <UploadLines uploads={uploads} />}
      </div>
    );
  }

  // Meeting recordings (and other videos) play inline once they are here.
  if (/^video\/(mp4|webm)$/.test(file.mime) && state === 'complete') {
    return (
      <div>
        <video
          className={styles.image}
          src={`./files/${file.sha256}?type=${encodeURIComponent(file.mime)}`}
          controls
          preload="metadata"
          data-testid="inline-video"
          title={file.name}
        />
        {uploads && uploads.length > 0 && <UploadLines uploads={uploads} />}
        {queued && <QueuedLine text={queued} />}
      </div>
    );
  }

  // Documents, sheets, slides, text and audio: a card with the first page (or lines, or cells).
  if (state === 'complete' && kind && kind !== 'image' && kind !== 'video') {
    return (
      <PreviewCard
        file={file}
        kind={kind}
        onShare={onShare}
        below={
          (uploads && uploads.length > 0) || queued ? (
            <>
              {uploads && uploads.length > 0 && <UploadLines uploads={uploads} />}
              {queued && <QueuedLine text={queued} />}
            </>
          ) : undefined
        }
      />
    );
  }

  const gone = state === 'gone';
  const actions =
    state === 'complete' ? (
      <>
        <Button size="small" appearance="primary" onClick={open} data-testid="file-open">
          {folder ? strings.files.openFolder2 : strings.files.open}
        </Button>
        <Button
          size="small"
          onClick={() => void core.invoke('files.showInFolder', { sha256: file.sha256 })}
          data-testid="file-show-in-folder"
        >
          {strings.files.showInFolder}
        </Button>
      </>
    ) : downloading ? (
      <Button
        size="small"
        onClick={() => void core.invoke('files.cancel', { sha256: file.sha256 })}
      >
        {strings.files.cancel}
      </Button>
    ) : gone && mine ? null : (
      <Button
        size="small"
        appearance="primary"
        onClick={() => download(file.sha256)}
        data-testid="file-download"
      >
        {gone
          ? strings.files.downloadAgain
          : folder
            ? strings.files.downloadFolder
            : strings.files.download}
      </Button>
    );
  return (
    <div
      className={mergeClasses(styles.card, gone && styles.missing)}
      data-testid="file-card"
      data-state={state}
    >
      <div className={styles.top}>
        {gone ? (
          <DocumentDismiss24Regular className={styles.icon} />
        ) : folder ? (
          <Folder24Regular className={styles.icon} />
        ) : (
          <Document24Regular className={styles.icon} />
        )}
        <div className={styles.text}>
          <Text weight="semibold" className={styles.name} title={file.name}>
            {file.name}
          </Text>
          {gone ? (
            <>
              <Text size={200} className={styles.danger} data-testid="file-missing">
                {strings.files.missing}
              </Text>
              {status?.error && (
                <Text size={200} className={styles.muted}>
                  {status.error}
                </Text>
              )}
            </>
          ) : (
            <Text size={200} className={styles.muted}>
              {downloading
                ? `${formatSize(status?.received ?? 0)} ${strings.files.of} ${formatSize(total)}`
                : folder
                  ? strings.files.folderOf(file.folder?.files ?? 0, formatSize(total))
                  : formatSize(file.size)}
            </Text>
          )}
          {downloading && (
            <div className={styles.line}>
              <Text size={200} className={styles.muted} data-testid="file-progress">
                {transferText(pct, status?.bytesPerSecond, status?.etaSeconds)}
              </Text>
              <ProgressBar value={pct} thickness="medium" />
            </div>
          )}
          {state === 'unavailable' && (
            <Text size={200} className={styles.muted}>
              {strings.files.unavailable}
            </Text>
          )}
          {state === 'failed' && (
            <Text size={200} className={styles.danger}>
              {strings.files.failed}
            </Text>
          )}
          {uploads && uploads.length > 0 && <UploadLines uploads={uploads} />}
          {queued && <QueuedLine text={queued} />}
        </div>
      </div>
      {actions && (
        <div className={styles.actions} data-testid="file-actions">
          {actions}
        </div>
      )}
    </div>
  );
}
