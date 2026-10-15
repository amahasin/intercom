import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Input,
  makeStyles,
  mergeClasses,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Select,
  Text,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowDownload16Regular,
  Dismiss16Regular,
  Open16Regular,
  Search20Regular,
} from '@fluentui/react-icons';
import type { FileListItem } from '@officemesh/protocol/ipc';
import { shortTime } from '../format.ts';
import { formatSize } from '../chat/FileCard.tsx';
import { openFile } from '../preview/store.ts';
import { core, displayName, openAt, useApp } from '../state.ts';
import { strings } from '../strings.ts';
import { FILE_GROUPS, filterFiles, NO_FILTER, type FileFilter } from './fileGroups.ts';

const useStyles = makeStyles({
  root: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflowY: 'auto' },
  header: { padding: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalXL}` },
  toolbar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    padding: `0 ${tokens.spacingHorizontalXL} ${tokens.spacingVerticalM}`,
  },
  search: { flex: '1 1 240px', maxWidth: '420px' },
  count: { color: tokens.colorNeutralForeground3, marginLeft: 'auto' },
  tableWrap: { padding: `0 ${tokens.spacingHorizontalXL} ${tokens.spacingVerticalXL}` },
  muted: { color: tokens.colorNeutralForeground3, padding: `0 ${tokens.spacingHorizontalXL}` },
  // The table is fixed-layout: a long name must not run into the next column, so every cell
  // clips its text with an ellipsis and the name takes whatever the other columns leave.
  cell: { overflow: 'hidden', minWidth: 0 },
  clip: {
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: '100%',
  },
  colIn: { width: '17%' },
  colBy: { width: '17%' },
  colWhen: { width: '17%' },
  colSize: { width: '11%' },
  colOpen: { width: '48px' },
  link: {
    display: 'block',
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
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
  const selfId = useApp((s) => s.identity?.userId);
  const [filter, setFilter] = useState<FileFilter>(NO_FILTER);
  const messageCount = useApp((s) =>
    convId ? s.messages[convId]?.length : Object.keys(s.messages).length,
  );

  useEffect(() => {
    void core
      .invoke('files.list', convId ? { convId } : {})
      .then(setItems)
      .catch(() => setItems([]));
  }, [convId, messageCount]);

  const shown = useMemo(
    () => filterFiles(items, filter, selfId, displayName),
    [items, filter, selfId],
  );
  // Who shared something, for the filter (the user first).
  const senders = useMemo(
    () => [...new Set(items.filter((f) => f.author !== selfId).map((f) => f.author))],
    [items, selfId],
  );
  const filtering = filter.text !== '' || filter.group !== 'all' || filter.from !== 'anyone';

  if (items.length === 0) {
    return (
      <Text as="p" className={styles.muted} data-testid="files-empty">
        {strings.filesView.none}
      </Text>
    );
  }
  return (
    <>
      <div className={styles.toolbar} data-testid="files-toolbar">
        <Input
          className={styles.search}
          contentBefore={<Search20Regular />}
          contentAfter={
            filter.text ? (
              <Button
                appearance="transparent"
                size="small"
                icon={<Dismiss16Regular />}
                aria-label={strings.filesView.clearSearch}
                onClick={() => setFilter({ ...filter, text: '' })}
              />
            ) : undefined
          }
          placeholder={strings.filesView.search}
          aria-label={strings.filesView.search}
          value={filter.text}
          onChange={(_e, d) => setFilter({ ...filter, text: d.value })}
          data-testid="files-search"
        />
        <Select
          aria-label={strings.filesView.type}
          value={filter.group}
          onChange={(_e, d) => setFilter({ ...filter, group: d.value as FileFilter['group'] })}
          data-testid="files-type"
        >
          <option value="all">{strings.filesView.groups.all}</option>
          {FILE_GROUPS.map((g) => (
            <option key={g} value={g}>
              {strings.filesView.groups[g]}
            </option>
          ))}
        </Select>
        <Select
          aria-label={strings.filesView.from}
          value={filter.from}
          onChange={(_e, d) => setFilter({ ...filter, from: d.value })}
          data-testid="files-from"
        >
          <option value="anyone">{strings.filesView.fromAnyone}</option>
          <option value="me">{strings.filesView.fromMe}</option>
          {senders.map((u) => (
            <option key={u} value={u}>
              {displayName(u)}
            </option>
          ))}
        </Select>
        {filtering && (
          <Button size="small" onClick={() => setFilter(NO_FILTER)} data-testid="files-clear">
            {strings.filesView.clearFilters}
          </Button>
        )}
        <Text size={200} className={styles.count} data-testid="files-count">
          {strings.filesView.count(shown.length, items.length)}
        </Text>
      </div>
      {shown.length === 0 ? (
        <Text as="p" className={styles.muted} data-testid="files-no-match">
          {strings.filesView.noMatch}
        </Text>
      ) : (
        <div className={styles.tableWrap}>
          <Table size="small" data-testid="files-table" aria-label={strings.filesView.title}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell className={styles.cell}>{strings.filesView.name}</TableHeaderCell>
                {!convId && (
                  <TableHeaderCell className={mergeClasses(styles.cell, styles.colIn)}>
                    {strings.filesView.sharedIn}
                  </TableHeaderCell>
                )}
                <TableHeaderCell className={mergeClasses(styles.cell, styles.colBy)}>
                  {strings.filesView.sharedBy}
                </TableHeaderCell>
                <TableHeaderCell className={mergeClasses(styles.cell, styles.colWhen)}>
                  {strings.filesView.when}
                </TableHeaderCell>
                <TableHeaderCell className={mergeClasses(styles.cell, styles.colSize)}>
                  {strings.filesView.size}
                </TableHeaderCell>
                <TableHeaderCell className={mergeClasses(styles.cell, styles.colOpen)} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((f) => {
                const state = statuses[f.sha256]?.state ?? f.state;
                return (
                  <TableRow
                    key={`${f.convId}:${f.message.author}:${f.message.seq}`}
                    data-testid="file-row"
                  >
                    <TableCell className={styles.cell}>
                      <button
                        type="button"
                        className={styles.link}
                        title={f.name}
                        onClick={() => void openAt(f.convId, f.message)}
                      >
                        {f.name}
                      </button>
                    </TableCell>
                    {!convId && (
                      <TableCell className={mergeClasses(styles.cell, styles.colIn)}>
                        <span className={styles.clip} title={f.conversation}>
                          {f.conversation}
                        </span>
                      </TableCell>
                    )}
                    <TableCell className={mergeClasses(styles.cell, styles.colBy)}>
                      <span className={styles.clip} title={displayName(f.author)}>
                        {displayName(f.author)}
                      </span>
                    </TableCell>
                    <TableCell className={mergeClasses(styles.cell, styles.colWhen)}>
                      <span className={styles.clip}>{shortTime(f.at)}</span>
                    </TableCell>
                    <TableCell className={mergeClasses(styles.cell, styles.colSize)}>
                      <span className={styles.clip}>{formatSize(f.size)}</span>
                    </TableCell>
                    <TableCell className={mergeClasses(styles.cell, styles.colOpen)}>
                      {state === 'complete' ? (
                        <Button
                          size="small"
                          appearance="subtle"
                          icon={<Open16Regular />}
                          aria-label={strings.files.open}
                          onClick={() =>
                            openFile({ sha256: f.sha256, name: f.name, size: f.size, mime: f.mime })
                          }
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
        </div>
      )}
    </>
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
