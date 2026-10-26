import { useMemo, useState } from 'react';
import {
  Avatar,
  Button,
  Input,
  makeStyles,
  mergeClasses,
  Text,
  tokens,
} from '@fluentui/react-components';
import {
  Call20Regular,
  Search20Regular,
  Settings20Regular,
  Video20Regular,
} from '@fluentui/react-icons';
import type { PersonView } from '@officemesh/protocol/ipc';
import { presenceBadge, presenceLine } from '../format.ts';
import { SettingsDialog } from '../shell/SettingsDialog.tsx';
import { avatarSrc, nameOf, useApp } from '../state.ts';
import { PersonHover } from '../people/ProfileHover.tsx';
import { strings } from '../strings.ts';
import { frequentContacts, selectCallsPerson, useCallHistory, useCallsView } from './callsStore.ts';
import { startCall } from './engine.ts';

const useStyles = makeStyles({
  root: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
  dial: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalS,
    padding: `0 ${tokens.spacingHorizontalL} ${tokens.spacingVerticalM}`,
  },
  buttons: { display: 'flex', columnGap: tokens.spacingHorizontalS },
  grow: { flex: 1 },
  list: { flex: 1, minHeight: 0, overflowY: 'auto', paddingBottom: tokens.spacingVerticalM },
  heading: {
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL} ${tokens.spacingVerticalXS}`,
    color: tokens.colorNeutralForeground3,
  },
  wrap: { position: 'relative', ':hover .om-row-more': { opacity: 1 } },
  row: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalM,
    width: 'calc(100% - 16px)',
    margin: '0 8px',
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    border: 'none',
    borderRadius: tokens.borderRadiusMedium,
    background: 'transparent',
    color: tokens.colorNeutralForeground1,
    textAlign: 'left',
    cursor: 'pointer',
    ':hover': { background: tokens.colorSubtleBackgroundHover },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}` },
  },
  selected: { background: tokens.colorSubtleBackgroundSelected },
  text: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 },
  ellipsis: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  muted: { color: tokens.colorNeutralForeground3 },
  quick: {
    position: 'absolute',
    right: '14px',
    top: '50%',
    transform: 'translateY(-50%)',
    display: 'flex',
    opacity: 0,
    ':focus-within': { opacity: 1 },
  },
  note: {
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL}`,
    color: tokens.colorNeutralForeground3,
  },
  footer: {
    padding: tokens.spacingHorizontalS,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
});

/** The left of the Calls page: a box to call a colleague by name, the people called most, and who is online. */
export function CallsPane() {
  const s = useStyles();
  const people = useApp((st) => st.people);
  const selfId = useApp((st) => st.identity?.userId);
  const selection = useCallsView((st) => st.selection);
  const history = useCallHistory();
  const [find, setFind] = useState('');
  const [devices, setDevices] = useState(false);

  const { first, groups } = useMemo(() => {
    const everyone = Object.values(people).filter((p) => p.userId !== selfId && !p.hidden);
    const byName = (a: PersonView, b: PersonView) =>
      nameOf(a, a.userId).localeCompare(nameOf(b, b.userId));
    const needle = find.trim().toLowerCase();
    if (needle) {
      const found = everyone
        .filter((p) => nameOf(p, p.userId).toLowerCase().includes(needle))
        .sort((a, b) => (a.online === b.online ? byName(a, b) : a.online ? -1 : 1))
        .slice(0, 60);
      return {
        first: found[0],
        groups: [{ key: 'results', label: strings.callsPage.results, people: found }],
      };
    }
    const frequent = frequentContacts(history, selfId)
      .map((id) => people[id])
      .filter((p): p is PersonView => p !== undefined && !p.hidden)
      .slice(0, 6);
    const seen = new Set(frequent.map((p) => p.userId));
    const online = everyone.filter((p) => p.online && !seen.has(p.userId)).sort(byName);
    return {
      first: undefined,
      groups: [
        { key: 'frequent', label: strings.callsPage.frequent, people: frequent },
        { key: 'online', label: strings.callsPage.onlineNow, people: online },
      ].filter((g) => g.people.length > 0),
    };
  }, [people, selfId, history, find]);

  const target = first && first.online ? first : undefined;
  const targetName = first ? nameOf(first, first.userId) : '';
  const call = (media: 'audio' | 'video', who: PersonView | undefined) => {
    if (who?.online) void startCall([who.userId], media);
  };

  return (
    <div className={s.root} data-testid="calls-pane">
      <div className={s.dial}>
        <Input
          contentBefore={<Search20Regular />}
          placeholder={strings.callsPage.typeName}
          aria-label={strings.callsPage.typeName}
          value={find}
          onChange={(_e, d) => setFind(d.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') call('audio', target);
          }}
          data-testid="calls-find"
        />
        <div className={s.buttons}>
          <Button
            className={s.grow}
            appearance="primary"
            icon={<Call20Regular />}
            disabled={!target}
            title={target ? strings.callsPage.callPerson(targetName) : undefined}
            onClick={() => call('audio', target)}
            data-testid="calls-dial-audio"
          >
            {strings.callsPage.call}
          </Button>
          <Button
            className={s.grow}
            icon={<Video20Regular />}
            disabled={!target}
            title={target ? strings.callsPage.videoPerson(targetName) : undefined}
            onClick={() => call('video', target)}
            data-testid="calls-dial-video"
          >
            {strings.callsPage.video}
          </Button>
        </div>
      </div>
      <div className={s.list} data-testid="calls-people">
        {groups.length === 0 && (
          <Text as="p" size={200} className={s.note}>
            {find.trim() ? strings.callsPage.noMatch : strings.callsPage.nobodyOnline}
          </Text>
        )}
        {groups.map((group) => (
          <div key={group.key}>
            <Text as="p" size={200} weight="semibold" className={s.heading}>
              {group.label}
            </Text>
            {group.people.length === 0 && (
              <Text as="p" size={200} className={s.note}>
                {strings.callsPage.noMatch}
              </Text>
            )}
            {group.people.map((person) => {
              const name = nameOf(person, person.userId);
              const on = selection?.kind === 'person' && selection.userId === person.userId;
              return (
                <div key={person.userId} className={s.wrap}>
                  <button
                    type="button"
                    className={mergeClasses(s.row, on && s.selected)}
                    onClick={() => selectCallsPerson(person.userId)}
                    aria-current={on ? 'true' : undefined}
                    data-testid={`calls-person-${person.userId}`}
                  >
                    <PersonHover userId={person.userId} clickOpens={false}>
                      <Avatar
                        name={name}
                        size={32}
                        color="colorful"
                        image={avatarSrc(person.avatarHash)}
                        badge={presenceBadge(person.presence)}
                      />
                    </PersonHover>
                    <span className={s.text}>
                      <Text className={s.ellipsis}>{name}</Text>
                      <Text size={200} className={mergeClasses(s.ellipsis, s.muted)}>
                        {person.online
                          ? person.jobTitle || presenceLine(person)
                          : presenceLine(person)}
                      </Text>
                    </span>
                  </button>
                  {person.online && (
                    <span className={mergeClasses('om-row-more', s.quick)}>
                      <Button
                        size="small"
                        appearance="subtle"
                        icon={<Call20Regular />}
                        aria-label={strings.callsPage.callPerson(name)}
                        title={strings.callsPage.callPerson(name)}
                        onClick={() => call('audio', person)}
                        data-testid={`calls-call-${person.userId}`}
                      />
                      <Button
                        size="small"
                        appearance="subtle"
                        icon={<Video20Regular />}
                        aria-label={strings.callsPage.videoPerson(name)}
                        title={strings.callsPage.videoPerson(name)}
                        onClick={() => call('video', person)}
                        data-testid={`calls-video-${person.userId}`}
                      />
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className={s.footer}>
        <Button
          appearance="subtle"
          icon={<Settings20Regular />}
          onClick={() => setDevices(true)}
          data-testid="calls-devices"
        >
          {strings.callsPage.devices}
        </Button>
      </div>
      {devices && <SettingsDialog initial="calls" onClose={() => setDevices(false)} />}
    </div>
  );
}
