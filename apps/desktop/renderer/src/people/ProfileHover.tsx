/**
 * Hover (or click) the thing that stands for a person or a group, and its card opens: a person's
 * contact details, or a group's members. The card is only built while it is open: Fluent's exit
 * motion can stall when the card's own content changes as it closes (Accept), leaving a closed
 * card on screen.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import {
  Avatar,
  makeStyles,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  Text,
  tokens,
  type PopoverProps,
} from '@fluentui/react-components';
import type { ConversationView, MemberView, PersonView } from '@officemesh/protocol/ipc';
import { GroupAvatar } from '../chat/GroupAvatar.tsx';
import { presenceBadge } from '../format.ts';
import { PresenceDot } from '../shell/PresenceDot.tsx';
import { avatarSrc, core, useApp } from '../state.ts';
import { strings } from '../strings.ts';
import { ProfileCard } from './ProfileCard.tsx';

/** How long the pointer rests on something before its card opens (so passing over does not flash cards). */
const OPEN_AFTER_MS = 450;
const CLOSE_AFTER_MS = 200;

type Where = NonNullable<PopoverProps['positioning']>;
/** The one element that stands for the person or group: the card opens from it. */
export type Trigger = ReactElement;

function Hover({
  children,
  card,
  positioning,
  testId,
  clickOpens,
}: {
  children: Trigger;
  card: (close: () => void) => ReactElement;
  positioning: Where;
  testId?: string;
  /**
   * A click opens the card too (a picture that stands for the person). Where the click does
   * something else (a row that opens the chat) it closes the card: one that opens over the page
   * just opened is in the way.
   */
  clickOpens: boolean;
}) {
  const [open, setOpen] = useState(false);
  const pending = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(pending.current), []);
  return (
    <Popover
      open={open}
      onOpenChange={(e, d) => {
        // Fluent opens at once on hover; resting the pointer for a moment is what opens a card.
        window.clearTimeout(pending.current);
        // A click is for what the thing does (open the chat), not for the card: it closes it. The
        // card opens only when the pointer comes in, so it does not come back by itself.
        if (!clickOpens && e.type === 'click') {
          setOpen(false);
          return;
        }
        if (d.open && e.type === 'mouseenter')
          pending.current = window.setTimeout(() => setOpen(true), OPEN_AFTER_MS);
        else setOpen(d.open);
      }}
      openOnHover
      mouseLeaveDelay={CLOSE_AFTER_MS}
      withArrow
      positioning={positioning}
    >
      <PopoverTrigger disableButtonEnhancement>{children}</PopoverTrigger>
      {open ? (
        <PopoverSurface data-testid={testId}>{card(() => setOpen(false))}</PopoverSurface>
      ) : (
        <></>
      )}
    </Popover>
  );
}

/**
 * A person's contact card on hover. `primary` is `profile` where the chat with them is already
 * the thing on screen (the card then offers their page, not a chat).
 */
export function ProfileHover({
  person,
  primary = 'chat',
  positioning = 'below-start',
  clickOpens = true,
  children,
}: {
  person: PersonView;
  primary?: 'chat' | 'profile';
  positioning?: Where;
  clickOpens?: boolean;
  children: Trigger;
}) {
  return (
    <Hover
      clickOpens={clickOpens}
      positioning={positioning}
      testId="profile-hover"
      card={(close) => <ProfileCard person={person} onClose={close} primary={primary} />}
    >
      {children}
    </Hover>
  );
}

const useStyles = makeStyles({
  card: {
    width: '300px',
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalM,
  },
  top: { display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalM },
  muted: { color: tokens.colorNeutralForeground3 },
  members: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalXS },
  member: { display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalS },
});

const SHOWN_MEMBERS = 8;

/** A group's card: its picture and name, how many are in it and who (the first few). */
export function GroupCard({ conv }: { conv: ConversationView }) {
  const styles = useStyles();
  const people = useApp((s) => s.people);
  const [members, setMembers] = useState<MemberView[]>();
  useEffect(() => {
    let live = true;
    void core
      .invoke('conversations.members', { convId: conv.convId })
      .then((list) => live && setMembers(list))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [conv.convId]);
  const shown = members?.slice(0, SHOWN_MEMBERS) ?? [];
  return (
    <div className={styles.card} data-testid="group-card" aria-label={conv.title}>
      <div className={styles.top}>
        <GroupAvatar title={conv.title} picture={conv.picture} size={48} />
        <div>
          <Text as="h3" size={400} weight="semibold" block>
            {conv.title}
          </Text>
          <Text size={200} className={styles.muted}>
            {strings.person.group(conv.memberCount)}
          </Text>
        </div>
      </div>
      <div className={styles.members}>
        {shown.map((m) => (
          <div key={m.userId} className={styles.member} data-testid="group-card-member">
            <Avatar
              name={m.name}
              size={24}
              color="colorful"
              image={avatarSrc(m.avatarHash)}
              badge={presenceBadge(
                m.online ? (people[m.userId]?.presence ?? 'available') : 'offline',
              )}
            />
            <Text size={200}>{m.name}</Text>
            {m.online && <PresenceDot state={people[m.userId]?.presence ?? 'available'} />}
          </div>
        ))}
        {members && members.length > SHOWN_MEMBERS && (
          <Text size={200} className={styles.muted}>
            {strings.person.moreMembers(members.length - SHOWN_MEMBERS)}
          </Text>
        )}
      </div>
    </div>
  );
}

/** A group's card on hover. */
export function GroupHover({
  conv,
  positioning = 'below-start',
  clickOpens = true,
  children,
}: {
  conv: ConversationView;
  positioning?: Where;
  clickOpens?: boolean;
  children: Trigger;
}) {
  return (
    <Hover
      clickOpens={clickOpens}
      positioning={positioning}
      testId="group-hover"
      card={() => <GroupCard conv={conv} />}
    >
      {children}
    </Hover>
  );
}
