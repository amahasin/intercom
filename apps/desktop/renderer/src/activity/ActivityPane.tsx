import { useEffect, useState } from 'react';
import {
  Avatar,
  Button,
  makeStyles,
  mergeClasses,
  Tab,
  TabList,
  Text,
  tokens,
} from '@fluentui/react-components';
import type { MessageView } from '@officemesh/protocol/ipc';
import { shortTime } from '../format.ts';
import { avatarSrc, core, displayName, openAt, useApp } from '../state.ts';
import { strings } from '../strings.ts';

const useStyles = makeStyles({
  root: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 },
  tabs: { padding: `0 ${tokens.spacingHorizontalS}` },
  list: { flex: 1, overflowY: 'auto', padding: `${tokens.spacingVerticalS} 0` },
  item: {
    display: 'flex',
    columnGap: tokens.spacingHorizontalM,
    width: 'calc(100% - 16px)',
    margin: '0 8px',
    padding: tokens.spacingHorizontalS,
    border: 'none',
    borderRadius: tokens.borderRadiusMedium,
    background: 'transparent',
    textAlign: 'left',
    color: tokens.colorNeutralForeground1,
    cursor: 'pointer',
    ':hover': { background: tokens.colorSubtleBackgroundHover },
  },
  unread: { fontWeight: tokens.fontWeightSemibold },
  text: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 },
  ellipsis: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  muted: { color: tokens.colorNeutralForeground3 },
  note: { padding: tokens.spacingHorizontalL, color: tokens.colorNeutralForeground3 },
});

/** Mentions, replies and reactions to the user's messages; and saved messages. */
export function ActivityPane() {
  const styles = useStyles();
  const items = useApp((s) => s.activity);
  const people = useApp((s) => s.people);
  const [tab, setTab] = useState<'all' | 'unread' | 'saved'>('all');
  const [saved, setSaved] = useState<MessageView[]>([]);
  useEffect(() => {
    if (tab === 'saved') void core.invoke('messages.saved', {}).then(setSaved);
  }, [tab]);
  const shown = tab === 'unread' ? items.filter((i) => !i.read) : items;

  return (
    <div className={styles.root}>
      <TabList
        className={styles.tabs}
        size="small"
        selectedValue={tab}
        onTabSelect={(_e, d) => setTab(d.value as typeof tab)}
      >
        <Tab value="all">{strings.activity.all}</Tab>
        <Tab value="unread">{strings.activity.unread}</Tab>
        <Tab value="saved" data-testid="activity-saved">
          {strings.activity.saved}
        </Tab>
      </TabList>
      {tab !== 'saved' && items.some((i) => !i.read) && (
        <Button
          appearance="transparent"
          size="small"
          onClick={() => void core.invoke('activity.markRead', {})}
        >
          {strings.activity.markAllRead}
        </Button>
      )}
      <div className={styles.list} data-testid="activity-list">
        {tab === 'saved' ? (
          saved.length === 0 ? (
            <Text as="p" size={200} className={styles.note}>
              {strings.activity.savedEmpty}
            </Text>
          ) : (
            saved.map((m) => (
              <button
                key={`${m.convId}:${m.id}`}
                type="button"
                className={styles.item}
                onClick={() => void openAt(m.convId, m)}
                data-testid="saved-item"
              >
                <Avatar
                  name={displayName(m.author)}
                  size={32}
                  image={avatarSrc(people[m.author]?.avatarHash)}
                />
                <span className={styles.text}>
                  <Text size={200} weight="semibold">
                    {displayName(m.author)} · {shortTime(m.at)}
                  </Text>
                  <Text size={200} className={styles.ellipsis}>
                    {m.text || m.file?.name}
                  </Text>
                </span>
              </button>
            ))
          )
        ) : shown.length === 0 ? (
          <Text as="p" size={200} className={styles.note}>
            {strings.activity.empty}
          </Text>
        ) : (
          shown.map((a) => {
            const who = displayName(a.author);
            const title =
              a.kind === 'mention'
                ? strings.activity.mention(who)
                : a.kind === 'reply'
                  ? strings.activity.reply(who)
                  : strings.activity.reaction(who, a.emoji ?? '');
            return (
              <button
                key={a.id}
                type="button"
                className={mergeClasses(styles.item, !a.read && styles.unread)}
                data-testid={`activity-${a.kind}`}
                onClick={() => {
                  void core.invoke('activity.markRead', { ids: [a.id] });
                  void openAt(a.convId, a.target);
                }}
              >
                <Avatar
                  name={who}
                  size={32}
                  color="colorful"
                  image={avatarSrc(people[a.author]?.avatarHash)}
                />
                <span className={styles.text}>
                  <Text
                    size={200}
                    weight={a.read ? 'regular' : 'semibold'}
                    className={styles.ellipsis}
                  >
                    {title}
                  </Text>
                  <Text size={200} className={mergeClasses(styles.ellipsis, styles.muted)}>
                    {a.excerpt}
                  </Text>
                  <Text size={100} className={styles.muted}>
                    {shortTime(a.at)}
                  </Text>
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
