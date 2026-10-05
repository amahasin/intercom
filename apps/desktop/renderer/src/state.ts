import { create } from 'zustand';
import {
  createIpcClient,
  type ActivityItem,
  type AppInfo,
  type ConversationView,
  type CoreStatus,
  type FileStatus,
  type IdentityView,
  type MessageView,
  type NetworkStatus,
  type PersonView,
  type PresenceView,
  type Settings,
} from '@officemesh/protocol/ipc';
import type { MsgRef } from '@officemesh/protocol';

export type RailId = 'activity' | 'chat' | 'teams' | 'calendar' | 'calls' | 'files';

interface AppState {
  status: CoreStatus;
  identity: IdentityView | undefined;
  info: AppInfo | undefined;
  presence: PresenceView | undefined;
  network: NetworkStatus | undefined;
  settings: Settings | undefined;
  people: Record<string, PersonView>;
  conversations: Record<string, ConversationView>;
  /** Loaded messages per conversation, in display order. */
  messages: Record<string, MessageView[]>;
  files: Record<string, FileStatus>;
  activity: ActivityItem[];
  activityUnread: number;
  /** Who is typing where, until when. */
  typing: Record<string, Record<string, number>>;
  rail: RailId;
  selectedConv: string | undefined;
  /** A message to scroll to and highlight (search hits, activity, toasts). */
  focusMessage: { convId: string; id: string } | undefined;
  replyTo: Record<string, MessageView | undefined>;
  editing: { convId: string; message: MessageView } | undefined;
  setRail: (rail: RailId) => void;
}

export const useApp = create<AppState>((set) => ({
  status: { state: 'starting' },
  identity: undefined,
  info: undefined,
  presence: undefined,
  network: undefined,
  settings: undefined,
  people: {},
  conversations: {},
  messages: {},
  files: {},
  activity: [],
  activityUnread: 0,
  typing: {},
  rail: 'chat',
  selectedConv: undefined,
  focusMessage: undefined,
  replyTo: {},
  editing: undefined,
  setRail: (rail) => set({ rail }),
}));

/** The renderer's only channel to the core. */
export const core = createIpcClient({
  send: (frame) => window.officemesh.send(frame),
  onFrame: (listener) => window.officemesh.onFrame(listener),
});

const order = (a: MessageView, b: MessageView) =>
  a.hlc.t - b.hlc.t ||
  a.hlc.c - b.hlc.c ||
  (a.author < b.author ? -1 : a.author > b.author ? 1 : 0);

/** Insert or replace messages by id, keeping display order. */
function mergeMessages(
  existing: MessageView[] | undefined,
  incoming: MessageView[],
): MessageView[] {
  const byId = new Map((existing ?? []).map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort(order);
}

function index<T>(items: T[], key: (item: T) => string): Record<string, T> {
  return Object.fromEntries(items.map((i) => [key(i), i]));
}

function mergeInto(convId: string, messages: MessageView[]): void {
  useApp.setState((s) => ({
    messages: { ...s.messages, [convId]: mergeMessages(s.messages[convId], messages) },
  }));
}

/** Tell the core what is on screen: it suppresses toasts and marks the open chat read. */
export function reportUi(): void {
  const s = useApp.getState();
  const activeConvId = s.rail === 'chat' ? (s.selectedConv ?? null) : null;
  void core.invoke('ui.state', {
    activeConvId,
    windowFocused: document.hasFocus() && !document.hidden,
  });
}

export async function bootstrap(): Promise<void> {
  core.on('core.status', (status) => useApp.setState({ status }));
  core.on('identity.changed', (identity) => useApp.setState({ identity }));
  core.on('presence.changed', (presence) => useApp.setState({ presence }));
  core.on('network.changed', (network) => useApp.setState({ network }));
  core.on('settings.changed', (settings) => useApp.setState({ settings }));
  core.on('people.changed', ({ people }) =>
    useApp.setState((s) => ({ people: { ...s.people, ...index(people, (p) => p.userId) } })),
  );
  core.on('conversations.changed', ({ conversations }) =>
    useApp.setState((s) => ({
      conversations: { ...s.conversations, ...index(conversations, (c) => c.convId) },
    })),
  );
  const onMessages = ({ convId, messages }: { convId: string; messages: MessageView[] }) => {
    // Only conversations whose history is loaded keep live updates; others load on open.
    if (useApp.getState().messages[convId]) mergeInto(convId, messages);
    for (const m of messages)
      if (m.file && !useApp.getState().files[m.file.sha256]) void refreshFiles([m.file.sha256]);
  };
  core.on('messages.added', onMessages);
  core.on('messages.updated', onMessages);
  core.on('files.progress', (status) =>
    useApp.setState((s) => ({ files: { ...s.files, [status.sha256]: status } })),
  );
  core.on('activity.changed', ({ items, unread }) =>
    useApp.setState({ activity: items, activityUnread: unread }),
  );
  core.on('typing', ({ convId, userId }) =>
    useApp.setState((s) => ({
      typing: { ...s.typing, [convId]: { ...s.typing[convId], [userId]: Date.now() + 5_000 } },
    })),
  );
  core.on('ui.open', ({ convId, target }) => void openAt(convId, target));

  window.addEventListener('focus', reportUi);
  window.addEventListener('blur', reportUi);
  document.addEventListener('visibilitychange', reportUi);
  useApp.subscribe((s, prev) => {
    if (s.selectedConv !== prev.selectedConv || s.rail !== prev.rail) reportUi();
  });

  try {
    const [identity, info, presence, network, people, conversations, activity, settings] =
      await Promise.all([
        core.invoke('identity.get', {}),
        core.invoke('app.info', {}),
        core.invoke('presence.get', {}),
        core.invoke('network.status', {}),
        core.invoke('people.list', {}),
        core.invoke('conversations.list', {}),
        core.invoke('activity.list', {}),
        core.invoke('settings.get', {}),
      ]);
    useApp.setState({
      identity,
      info,
      presence,
      network,
      settings,
      people: index(people, (p) => p.userId),
      conversations: index(conversations, (c) => c.convId),
      activity,
      activityUnread: activity.filter((a) => !a.read).length,
      status: { state: 'ready' },
    });
  } catch (err) {
    useApp.setState({
      status: { state: 'error', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

export async function refreshFiles(sha256s: string[]): Promise<void> {
  if (sha256s.length === 0) return;
  const statuses = await core.invoke('files.status', { sha256s });
  useApp.setState((s) => ({ files: { ...s.files, ...index(statuses, (f) => f.sha256) } }));
}

async function loadMessages(convId: string): Promise<void> {
  const messages = await core.invoke('messages.list', { convId, limit: 200 });
  mergeInto(convId, messages);
  await refreshFiles([...new Set(messages.flatMap((m) => (m.file ? [m.file.sha256] : [])))]);
}

export async function selectConversation(convId: string | undefined): Promise<void> {
  useApp.setState({ selectedConv: convId, rail: 'chat' });
  if (!convId) return;
  await loadMessages(convId);
  reportUi();
}

/** Open a conversation scrolled to one message. */
export async function openAt(convId: string, target?: MsgRef): Promise<void> {
  await selectConversation(convId);
  if (!target) return;
  mergeInto(convId, await core.invoke('messages.context', { convId, target }));
  useApp.setState({ focusMessage: { convId, id: `${target.author}:${target.seq}` } });
}

export async function loadOlder(convId: string): Promise<number> {
  const first = useApp.getState().messages[convId]?.[0];
  if (!first) return 0;
  const older = await core.invoke('messages.list', {
    convId,
    limit: 200,
    before: { hlc: first.hlc, author: first.author },
  });
  mergeInto(convId, older);
  return older.length;
}

export async function openChatWith(userId: string): Promise<void> {
  const conv = await core.invoke('conversations.openDirect', { userId });
  useApp.setState((s) => ({ conversations: { ...s.conversations, [conv.convId]: conv } }));
  await selectConversation(conv.convId);
}

/** Run a message action and merge the returned view. */
export async function act(convId: string, run: () => Promise<MessageView>): Promise<void> {
  mergeInto(convId, [await run()]);
}

/** A person's name, or a stable placeholder until their profile arrives. */
export function nameOf(person: PersonView | undefined, userId: string): string {
  return person?.displayName ?? `Colleague ${userId.slice(0, 4).toUpperCase()}`;
}

export function displayName(userId: string): string {
  const s = useApp.getState();
  if (userId === s.identity?.userId) return s.identity.displayName;
  return nameOf(s.people[userId], userId);
}

/** Avatar image URL served by the app for a profile's avatar hash. */
export function avatarSrc(hash: string | undefined): { src: string } | undefined {
  return hash ? { src: `./avatars/${hash}` } : undefined;
}
