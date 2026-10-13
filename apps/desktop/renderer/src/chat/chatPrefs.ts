/**
 * How this user arranges the chat list: favourites, hidden chats, chats marked unread, which
 * sections are folded and which filter is on. These are personal preferences of this PC, kept
 * in the page's local storage (colleagues never see them).
 */
import { create } from 'zustand';

export type ChatFilter = 'all' | 'unread' | 'chats' | 'groups';

interface ChatPrefs {
  favorites: string[];
  /** A hidden chat comes back when something new arrives: convId -> activity time when hidden. */
  hidden: Record<string, number>;
  /** Marked unread by hand. */
  markedUnread: string[];
  folded: { favorites: boolean; chats: boolean; people: boolean };
  filter: ChatFilter;
}

const KEY = 'intercom.chat-prefs';

function load(): ChatPrefs {
  const fresh: ChatPrefs = {
    favorites: [],
    hidden: {},
    markedUnread: [],
    folded: { favorites: false, chats: false, people: false },
    filter: 'all',
  };
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return fresh;
    const parsed = JSON.parse(raw) as Partial<ChatPrefs>;
    return {
      favorites: Array.isArray(parsed.favorites) ? parsed.favorites.map(String) : [],
      hidden: typeof parsed.hidden === 'object' && parsed.hidden ? parsed.hidden : {},
      markedUnread: Array.isArray(parsed.markedUnread) ? parsed.markedUnread.map(String) : [],
      folded: { ...fresh.folded, ...parsed.folded },
      filter: parsed.filter ?? 'all',
    };
  } catch {
    return fresh;
  }
}

export const useChatPrefs = create<ChatPrefs>(() => load());

useChatPrefs.subscribe((state) => {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Storage can be unavailable; the preferences then last for this session only.
  }
});

const set = (patch: Partial<ChatPrefs>) => useChatPrefs.setState(patch);

export function toggleFavorite(convId: string): void {
  const { favorites } = useChatPrefs.getState();
  set({
    favorites: favorites.includes(convId)
      ? favorites.filter((c) => c !== convId)
      : [...favorites, convId],
  });
}

export function setMarkedUnread(convId: string, on: boolean): void {
  const { markedUnread } = useChatPrefs.getState();
  const without = markedUnread.filter((c) => c !== convId);
  set({ markedUnread: on ? [...without, convId] : without });
}

export function hideChat(convId: string, lastActivityAt: number): void {
  set({ hidden: { ...useChatPrefs.getState().hidden, [convId]: lastActivityAt } });
}

export function toggleFolded(section: keyof ChatPrefs['folded']): void {
  const { folded } = useChatPrefs.getState();
  set({ folded: { ...folded, [section]: !folded[section] } });
}

export function setChatFilter(filter: ChatFilter): void {
  set({ filter });
}
