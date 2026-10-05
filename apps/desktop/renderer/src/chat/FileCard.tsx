import { Button, makeStyles, ProgressBar, Text, tokens } from '@fluentui/react-components';
import { Document24Regular } from '@fluentui/react-icons';
import type { FileRef } from '@officemesh/protocol';
import { core, useApp } from '../state.ts';
import { strings } from '../strings.ts';

const useStyles = makeStyles({
  card: {
    display: 'flex',
    columnGap: tokens.spacingHorizontalM,
    alignItems: 'center',
    padding: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalXS,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground1,
    maxWidth: '380px',
  },
  text: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, rowGap: '2px' },
  name: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  muted: { color: tokens.colorNeutralForeground3 },
  image: {
    display: 'block',
    maxWidth: '360px',
    maxHeight: '320px',
    width: 'auto',
    height: 'auto',
    objectFit: 'contain',
    borderRadius: tokens.borderRadiusMedium,
    marginTop: tokens.spacingVerticalXS,
    cursor: 'pointer',
  },
  actions: { display: 'flex', columnGap: tokens.spacingHorizontalXS },
});

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

const toBase64 = (b64url: string) => b64url.replace(/-/g, '+').replace(/_/g, '/');

/** A shared file: inline image when it is here, otherwise a card with its state and actions. */
export function FileCard({ file }: { file: FileRef }) {
  const styles = useStyles();
  const status = useApp((s) => s.files[file.sha256]);
  const state = status?.state ?? 'missing';
  const isImage = /^image\/(png|jpeg|gif|webp|bmp)$/.test(file.mime);
  const open = () => void core.invoke('files.open', { sha256: file.sha256 });

  if (isImage && (state === 'complete' || file.thumb)) {
    const src =
      state === 'complete'
        ? `./files/${file.sha256}?type=${encodeURIComponent(file.mime)}`
        : `data:image/jpeg;base64,${toBase64(file.thumb!)}`;
    return (
      <img
        className={styles.image}
        src={src}
        alt={file.name}
        onClick={state === 'complete' ? open : undefined}
        data-testid="inline-image"
        data-state={state}
      />
    );
  }

  // Meeting recordings (and other videos) play inline once they are here.
  if (/^video\/(mp4|webm)$/.test(file.mime) && state === 'complete') {
    return (
      <video
        className={styles.image}
        src={`./files/${file.sha256}?type=${encodeURIComponent(file.mime)}`}
        controls
        preload="metadata"
        data-testid="inline-video"
        title={file.name}
      />
    );
  }

  const pct = status && status.size > 0 ? Math.floor((status.received / status.size) * 100) : 0;
  return (
    <div className={styles.card} data-testid="file-card" data-state={state}>
      <Document24Regular />
      <div className={styles.text}>
        <Text weight="semibold" className={styles.name} title={file.name}>
          {file.name}
        </Text>
        <Text size={200} className={styles.muted}>
          {formatSize(file.size)}
          {state === 'downloading' && ` · ${strings.files.progress(pct)}`}
        </Text>
        {state === 'downloading' && <ProgressBar value={pct / 100} thickness="medium" />}
        {state === 'unavailable' && (
          <Text size={200} className={styles.muted}>
            {strings.files.unavailable}
          </Text>
        )}
        {state === 'failed' && (
          <Text size={200} style={{ color: tokens.colorPaletteRedForeground1 }}>
            {strings.files.failed}
          </Text>
        )}
      </div>
      <div className={styles.actions}>
        {state === 'complete' ? (
          <>
            <Button size="small" appearance="primary" onClick={open} data-testid="file-open">
              {strings.files.open}
            </Button>
            <Button
              size="small"
              onClick={() => void core.invoke('files.showInFolder', { sha256: file.sha256 })}
            >
              {strings.files.showInFolder}
            </Button>
          </>
        ) : state === 'downloading' ? (
          <Button
            size="small"
            onClick={() => void core.invoke('files.cancel', { sha256: file.sha256 })}
          >
            {strings.files.cancel}
          </Button>
        ) : (
          <Button
            size="small"
            appearance="primary"
            onClick={() =>
              void core
                .invoke('files.download', { sha256: file.sha256 })
                .then((st) => useApp.setState((s) => ({ files: { ...s.files, [st.sha256]: st } })))
            }
            data-testid="file-download"
          >
            {strings.files.download}
          </Button>
        )}
      </div>
    </div>
  );
}
