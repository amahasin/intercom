/**
 * Hover (or click) the picture that stands for a person or a group, and its card opens: a
 * person's contact details, or a group's members. Only the picture opens it, wherever it is in
 * the app (a name or a row does not); the card comes up beside the picture, on the side that has
 * room, and offers what makes sense where it was opened: the chat, their page, or both. The card is only built while it is open: Fluent's exit
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
import { ProfileCard, type Offer } from './ProfileCard.tsx';

/** How long the pointer rests on something before its card opens (so passing over does not flash cards). */
const OPEN_AFTER_MS = 450;
const CLOSE_AFTER_MS = 200;

type Where = NonNullable<PopoverProps['positioning']>;

/**
 * Beside the picture (to its right, top edges level), and where there is no room there: to its
 * left, below it, above it. The card slides along an edge to stay inside the window, and is
 * kept a little way from it.
 */
export const BESIDE: Where = {
  position: 'after',
  align: 'top',
  fallbackPositions: ['before-top', 'below-start', 'above-start', 'after-bottom', 'before-bottom'],
  overflowBoundaryPadding: 8,
  autoSize: 'height',
};
/** The one element that stands for the person or group: the card opens from it. */
export type Trigger = ReactElement;

/**
 * What happens in the card stays in the card. The card is drawn elsewhere on the page but, to
 * React, it is inside the picture that opened it, and so inside the row that picture is in (a chat,
 * a person): without this a click on the card's **Profile** also reached the row, which opened the
 * chat after the page had been asked for, and a double click or a right click did the row's own
 * thing under the card.
 */
const keepToCard = {
  onClick: (e: { stopPropagation(): void }) => e.stopPropagation(),
  onDoubleClick: (e: { stopPropagation(): void }) => e.stopPropagation(),
  onContextMenu: (e: { stopPropagation(): void }) => e.stopPropagation(),
  onMouseDown: (e: { stopPropagation(): void }) => e.stopPropagation(),
  onKeyDown: (e: { stopPropagation(): void }) => e.stopPropagation(),
};

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
  // Focus moves into the card only when it was opened by a click or the keyboard. A card the
  // pointer opened must not take it: Fluent moves focus into an open popover and, when it closes,
  // gives it back to the row, which scrolls the list back to that row (and takes the typing focus
  // from the message box).
  const [focusIn, setFocusIn] = useState(false);
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
        if (d.open && e.type === 'mouseenter') {
          setFocusIn(false);
          pending.current = window.setTimeout(() => setOpen(true), OPEN_AFTER_MS);
        } else {
          if (d.open) setFocusIn(e.type !== 'mouseleave');
          setOpen(d.open);
        }
      }}
      openOnHover
      unstable_disableAutoFocus={!focusIn}
      mouseLeaveDelay={CLOSE_AFTER_MS}
      withArrow
      positioning={positioning}
    >
      <PopoverTrigger disableButtonEnhancement>{children}</PopoverTrigger>
      {open ? (
        <PopoverSurface data-testid={testId} {...keepToCard}>
          {card(() => setOpen(false))}
        </PopoverSurface>
      ) : (
        <></>
      )}
    </Popover>
  );
}

/** A person's contact card on hover (see `Offer`: what its buttons do where it opened). */
export function ProfileHover({
  person,
  offer = 'both',
  positioning = BESIDE,
  clickOpens = true,
  children,
}: {
  person: PersonView;
  offer?: Offer;
  positioning?: Where;
  clickOpens?: boolean;
  children: Trigger;
}) {
  return (
    <Hover
      clickOpens={clickOpens}
      positioning={positioning}
      testId="profile-hover"
      card={(close) => <ProfileCard person={person} onClose={close} offer={offer} />}
    >
      {children}
    </Hover>
  );
}

/**
 * What a person's card offers where it opened: with the chat with them already on screen their
 * page, with their page already on screen the chat, anywhere else (a group chat, a list, Activity,
 * a call) both.
 */
function offerHere(s: ReturnType<typeof useApp.getState>, userId: string): Offer {
  const open = s.selectedConv ? s.conversations[s.selectedConv] : undefined;
  if (s.rail === 'chat' && open?.peerUserId === userId) return 'profile';
  if (s.rail === 'people' && s.selectedPerson === userId) return 'chat';
  return 'both';
}

/**
 * The picture of a colleague, with their card on it: put it round an avatar. Someone this PC
 * does not know, and this user's own picture, have no card (nothing is wrapped). Where a click on
 * the picture does something else (a row that opens the chat), pass `clickOpens={false}`: the
 * click then closes the card instead of opening it.
 */
export function PersonHover({
  userId,
  clickOpens = true,
  children,
}: {
  userId: string | undefined;
  clickOpens?: boolean;
  children: Trigger;
}) {
  const person = useApp((s) => (userId ? s.people[userId] : undefined));
  const selfId = useApp((s) => s.identity?.userId);
  const offer = useApp((s) => (userId ? offerHere(s, userId) : 'both'));
  if (!person || person.userId === selfId) return children;
  return (
    <ProfileHover person={person} offer={offer} clickOpens={clickOpens}>
      {children}
    </ProfileHover>
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
  positioning = BESIDE,
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
