import { useState } from 'react';
import { Avatar, Checkbox, Input, makeStyles, Text, tokens } from '@fluentui/react-components';
import { Search20Regular } from '@fluentui/react-icons';
import { presenceBadge } from '../format.ts';
import { avatarSrc, nameOf } from '../state.ts';
import { PersonHover } from './ProfileHover.tsx';
import { useListedPeople } from './listed.ts';
import { strings } from '../strings.ts';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalS },
  list: {
    display: 'flex',
    flexDirection: 'column',
    maxHeight: '260px',
    overflowY: 'auto',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalXS,
  },
  row: { display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalS },
  muted: { color: tokens.colorNeutralForeground3, padding: tokens.spacingHorizontalS },
});

/** Choose colleagues known on this network (excluding `exclude`, e.g. current members). */
export function PeoplePicker({
  selected,
  onChange,
  exclude = [],
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
  exclude?: string[];
}) {
  const styles = useStyles();
  const everyone = useListedPeople();
  const [filter, setFilter] = useState('');
  const list = everyone
    .filter((p) => !exclude.includes(p.userId) && p.displayName)
    .filter((p) => nameOf(p, p.userId).toLowerCase().includes(filter.trim().toLowerCase()))
    .sort(
      (a, b) =>
        Number(b.online) - Number(a.online) ||
        nameOf(a, a.userId).localeCompare(nameOf(b, b.userId)),
    );
  return (
    <div className={styles.root}>
      <Input
        contentBefore={<Search20Regular />}
        placeholder={strings.chat.find}
        value={filter}
        onChange={(_e, d) => setFilter(d.value)}
        data-testid="people-picker-filter"
      />
      <div className={styles.list} role="group" aria-label={strings.groups.pickPeople}>
        {list.length === 0 && (
          <Text block size={200} className={styles.muted}>
            {strings.chat.noMatch}
          </Text>
        )}
        {list.map((p) => (
          <Checkbox
            key={p.userId}
            checked={selected.includes(p.userId)}
            onChange={(_e, d) =>
              onChange(
                d.checked ? [...selected, p.userId] : selected.filter((id) => id !== p.userId),
              )
            }
            data-testid={`pick-${p.userId}`}
            label={
              <span className={styles.row}>
                <PersonHover userId={p.userId} clickOpens={false}>
                  <Avatar
                    size={24}
                    name={nameOf(p, p.userId)}
                    color="colorful"
                    image={avatarSrc(p.avatarHash)}
                    badge={presenceBadge(p.presence)}
                  />
                </PersonHover>
                {nameOf(p, p.userId)}
              </span>
            }
          />
        ))}
      </div>
    </div>
  );
}
