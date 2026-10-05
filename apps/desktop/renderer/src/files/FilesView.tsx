import { useEffect, useState } from 'react';
import {
  Button,
  makeStyles,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  tokens,
} from '@fluentui/react-components';
import { ArrowDownload16Regular, Open16Regular } from '@fluentui/react-icons';
import type { FileListItem } from '@officemesh/protocol/ipc';
import { shortTime } from '../format.ts';
import { formatSize } from '../chat/FileCard.tsx';
import { core, displayName, openAt, useApp } from '../state.ts';
import { strings } from '../strings.ts';

const useStyles = makeStyles({
  root: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflowY: 'auto' },
  header: { padding: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalXL}` },
  table: { padding: `0 ${tokens.spacingHorizontalXL}` },
  muted: { color: tokens.colorNeutralForeground3, padding: `0 ${tokens.spacingHorizontalXL}` },
  link: {
    border: 'none',
    background: 'transparent',
    padding: 0,
    color: tokens.colorBrandForegroundLink,
    cursor: 'pointer',
    textAlign: 'left',
  },
});

/** Files shared in one conversation (channel Files tab) or everywhere (Files rail). */
export function FilesTable({ convId }: { convId?: string }) {
  const styles = useStyles();
  const [items, setItems] = useState<FileListItem[]>([]);
  const statuses = useApp((s) => s.files);
  const messageCount = useApp((s) =>
    convId ? s.messages[convId]?.length : Object.keys(s.messages).length,
  );

  useEffect(() => {
    void core
      .invoke('files.list', convId ? { convId } : {})
      .then(setItems)
      .catch(() => setItems([]));
  }, [convId, messageCount]);

  if (items.length === 0) {
    return (
      <Text as="p" className={styles.muted} data-testid="files-empty">
        {strings.filesView.none}
      </Text>
    );
  }
  return (
    <Table
      size="small"
      className={styles.table}
      data-testid="files-table"
      aria-label={strings.filesView.title}
    >
      <TableHeader>
        <TableRow>
          <TableHeaderCell>{strings.filesView.name}</TableHeaderCell>
          {!convId && <TableHeaderCell>{strings.filesView.sharedIn}</TableHeaderCell>}
          <TableHeaderCell>{strings.filesView.sharedBy}</TableHeaderCell>
          <TableHeaderCell>{strings.filesView.when}</TableHeaderCell>
          <TableHeaderCell>{strings.filesView.size}</TableHeaderCell>
          <TableHeaderCell />
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((f) => {
          const state = statuses[f.sha256]?.state ?? f.state;
          return (
            <TableRow
              key={`${f.convId}:${f.message.author}:${f.message.seq}`}
              data-testid="file-row"
            >
              <TableCell>
                <button
                  type="button"
                  className={styles.link}
                  onClick={() => void openAt(f.convId, f.message)}
                >
                  {f.name}
                </button>
              </TableCell>
              {!convId && <TableCell>{f.conversation}</TableCell>}
              <TableCell>{displayName(f.author)}</TableCell>
              <TableCell>{shortTime(f.at)}</TableCell>
              <TableCell>{formatSize(f.size)}</TableCell>
              <TableCell>
                {state === 'complete' ? (
                  <Button
                    size="small"
                    appearance="subtle"
                    icon={<Open16Regular />}
                    aria-label={strings.files.open}
                    onClick={() => void core.invoke('files.open', { sha256: f.sha256 })}
                  />
                ) : (
                  <Button
                    size="small"
                    appearance="subtle"
                    icon={<ArrowDownload16Regular />}
                    aria-label={strings.files.download}
                    onClick={() => void core.invoke('files.download', { sha256: f.sha256 })}
                  />
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function FilesView() {
  const styles = useStyles();
  return (
    <section className={styles.root} data-testid="files-view">
      <div className={styles.header}>
        <Text as="h2" size={500} weight="semibold" block>
          {strings.filesView.title}
        </Text>
        <Text size={200}>{strings.filesView.all}</Text>
      </div>
      <FilesTable />
    </section>
  );
}
