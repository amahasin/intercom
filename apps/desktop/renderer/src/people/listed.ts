import { useMemo, useState } from 'react';
import type { PersonView } from '@officemesh/protocol/ipc';
import { useApp } from '../state.ts';

/** A colleague nobody has heard from in this long, and never chatted with, drops off every list. */
const STALE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Whether someone belongs in the lists of people (the chat list, the pickers for a group or a
 * call, mentions, forwarding, search). Everyone online does. An offline person is left out when
 * the user removed them, when we never learned their name (a beacon heard once: nobody to talk
 * to), or when they were last seen long ago and there is no chat with them. Their chats are
 * never affected. One rule for every list, so someone removed from the side pane does not turn
 * up again when a group is made.
 */
export function isListed(p: PersonView, hasChat: boolean, now: number): boolean {
  if (p.online) return true;
  if (p.hidden) return false;
  if (hasChat) return true;
  return p.displayName !== undefined && now - p.lastSeen < STALE_MS;
}

/** The people (other than this user) who belong in a list, in no particular order. */
export function useListedPeople(): PersonView[] {
  const people = useApp((s) => s.people);
  const conversations = useApp((s) => s.conversations);
  const selfId = useApp((s) => s.identity?.userId);
  // When the window opened: "not seen for 30 days" does not need to be exact to the minute.
  const [now] = useState(() => Date.now());
  return useMemo(() => {
    const chatted = new Set(
      Object.values(conversations)
        .map((c) => c.peerUserId)
        .filter((id): id is string => id !== undefined),
    );
    return Object.values(people).filter(
      (p) => p.userId !== selfId && isListed(p, chatted.has(p.userId), now),
    );
  }, [people, conversations, selfId, now]);
}
