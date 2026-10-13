import { create } from 'zustand';
import { useAttachments } from './chat/attachments.ts';
import {
  createIpcClient,
  type ActivityItem,
  type AppInfo,
  type ConversationView,
  type CoreStatus,
  type FileStatus,
  type FileUpload,
  type IdentityView,
  type MessageView,
  type NetworkStatus,
  type PersonView,
  type PresenceView,
  type Settings,
  type TeamView,
} from '@officemesh/protocol/ipc';
import type { MsgRef } from '@officemesh/protocol';

export type RailId = 'activity' | 'chat' | 'people' | 'teams' | 'calendar' | 'calls' | 'files';

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
  /** Loaded channel threads (root then replies), by `${convId}|${rootId}`. */
  threads: Record<string, MessageView[]>;
  teams: Record<string, TeamView>;
  files: Record<string, FileStatus>;
  /** Who this PC is sending each file to right now, and how far along (by SHA-256). */
  uploads: Record<string, FileUpload[]>;
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
  threads: {},
  teams: {},
  files: {},
  uploads: {},
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

export const threadKey = (convId: string, rootId: string) => `${convId}|${rootId}`;

/**
 * Merge message views into what is loaded. In channels the main list holds root posts only;
 * replies go to their thread (if open) and roots are mirrored into an open thread's head.
 */
function mergeInto(convId: string, messages: MessageView[]): void {
  useApp.setState((s) => {
    const channel = s.conversations[convId]?.kind === 'channel';
    const roots = channel ? messages.filter((m) => !m.thread) : messages;
    const threads = { ...s.threads };
    if (channel) {
      for (const m of messages) {
        const key = threadKey(convId, m.thread ? `${m.thread.author}:${m.thread.seq}` : m.id);
        if (threads[key]) threads[key] = mergeMessages(threads[key], [m]);
      }
    }
    return {
      threads,
      messages:
        roots.length > 0 || !channel
          ? { ...s.messages, [convId]: mergeMessages(s.messages[convId], roots) }
          : s.messages,
    };
  });
}

export async function loadThread(convId: string, root: MsgRef): Promise<void> {
  const messages = await core.invoke('messages.thread', { convId, target: root });
  useApp.setState((s) => ({
    threads: { ...s.threads, [threadKey(convId, `${root.author}:${root.seq}`)]: messages },
  }));
}

export function closeThread(convId: string, rootId: string): void {
  useApp.setState((s) => {
    const threads = { ...s.threads };
    delete threads[threadKey(convId, rootId)];
    return { threads };
  });
}

/** Store a changed conversation view (from a command result). */
export function putConversation(conv: ConversationView): void {
  useApp.setState((s) => ({ conversations: { ...s.conversations, [conv.convId]: conv } }));
}

export async function refreshTeams(): Promise<void> {
  const teams = await core.invoke('teams.list', {});
  useApp.setState((s) => ({
    teams: index(teams, (t) => t.teamId),
    conversations: {
      ...s.conversations,
      ...index(
        teams.flatMap((t) => t.channels),
        (c) => c.convId,
      ),
    },
  }));
}

/** Tell the core what is on screen: it suppresses toasts and marks the open chat read. */
export function reportUi(): void {
  const s = useApp.getState();
  const activeConvId = s.rail === 'chat' || s.rail === 'teams' ? (s.selectedConv ?? null) : null;
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
  core.on('files.progress', (status) => mergeFileStatuses([status]));
  core.on('files.preparing', ({ prepareId, done, total }) =>
    useAttachments.setState((s) => ({
      preparing: { ...s.preparing, [prepareId]: { done, total } },
    })),
  );
  core.on('files.upload', ({ sha256, uploads }) =>
    useApp.setState((s) => {
      const next = { ...s.uploads };
      if (uploads.length > 0) next[sha256] = uploads;
      else delete next[sha256];
      return { uploads: next };
    }),
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
  core.on('teams.changed', ({ teams }) =>
    useApp.setState((s) => {
      // Channels are conversations too: keep their views current for headers and lists.
      const channels = teams.flatMap((t) => t.channels);
      return {
        teams: index(teams, (t) => t.teamId),
        conversations: { ...s.conversations, ...index(channels, (c) => c.convId) },
      };
    }),
  );
  // Membership changed what this PC may show: reload the conversation from scratch.
  core.on('conversation.reset', ({ convId }) => {
    const s = useApp.getState();
    if (!s.messages[convId]) return;
    const threads = Object.fromEntries(
      Object.entries(s.threads).filter(([k]) => !k.startsWith(`${convId}|`)),
    );
    const messages = { ...s.messages };
    delete messages[convId];
    useApp.setState({ messages, threads });
    void loadMessages(convId);
  });

  window.addEventListener('focus', reportUi);
  window.addEventListener('blur', reportUi);
  document.addEventListener('visibilitychange', reportUi);
  useApp.subscribe((s, prev) => {
    if (s.selectedConv !== prev.selectedConv || s.rail !== prev.rail) reportUi();
  });

  try {
    const [identity, info, presence, network, people, conversations, activity, settings, teams] =
      await Promise.all([
        core.invoke('identity.get', {}),
        core.invoke('app.info', {}),
        core.invoke('presence.get', {}),
        core.invoke('network.status', {}),
        core.invoke('people.list', {}),
        core.invoke('conversations.list', {}),
        core.invoke('activity.list', {}),
        core.invoke('settings.get', {}),
        core.invoke('teams.list', {}),
      ]);
    useApp.setState({
      identity,
      info,
      presence,
      network,
      settings,
      people: index(people, (p) => p.userId),
      conversations: {
        ...index(
          teams.flatMap((t) => t.channels),
          (c) => c.convId,
        ),
        ...index(conversations, (c) => c.convId),
      },
      teams: index(teams, (t) => t.teamId),
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

/** Put file statuses in the store, touching only the ones that changed (no needless redraws). */
export function mergeFileStatuses(statuses: FileStatus[]): void {
  const current = useApp.getState().files;
  const changed = statuses.filter((f) => {
    const old = current[f.sha256];
    return (
      !old ||
      old.state !== f.state ||
      old.received !== f.received ||
      old.size !== f.size ||
      old.error !== f.error ||
      old.bytesPerSecond !== f.bytesPerSecond ||
      old.etaSeconds !== f.etaSeconds
    );
  });
  if (changed.length > 0)
    useApp.setState((s) => ({ files: { ...s.files, ...index(changed, (f) => f.sha256) } }));
}

export async function refreshFiles(sha256s: string[]): Promise<void> {
  if (sha256s.length === 0) return;
  mergeFileStatuses(await core.invoke('files.status', { sha256s }));
}

const watchedFiles = new Map<string, number>();
let watchTimer: number | undefined;

/**
 * Keep an eye on a file while its card is on screen: a file deleted in Explorer turns into
 * "File is missing" within a few seconds. One timer checks every watched file in one call.
 */
export function watchFile(sha: string): () => void {
  watchedFiles.set(sha, (watchedFiles.get(sha) ?? 0) + 1);
  watchTimer ??= window.setInterval(() => {
    if (document.hidden || watchedFiles.size === 0) return;
    void refreshFiles([...watchedFiles.keys()].slice(0, 500)).catch(() => {});
  }, 3_000);
  return () => {
    const n = (watchedFiles.get(sha) ?? 1) - 1;
    if (n <= 0) watchedFiles.delete(sha);
    else watchedFiles.set(sha, n);
    if (watchedFiles.size === 0 && watchTimer !== undefined) {
      window.clearInterval(watchTimer);
      watchTimer = undefined;
    }
  };
}

export async function loadMessages(convId: string): Promise<void> {
  const channel = useApp.getState().conversations[convId]?.kind === 'channel';
  const messages = await core.invoke('messages.list', {
    convId,
    limit: 200,
    ...(channel && { rootsOnly: true }),
  });
  mergeInto(convId, messages);
  await refreshFiles([...new Set(messages.flatMap((m) => (m.file ? [m.file.sha256] : [])))]);
}

export async function selectConversation(convId: string | undefined): Promise<void> {
  const kind = convId ? useApp.getState().conversations[convId]?.kind : undefined;
  useApp.setState({ selectedConv: convId, rail: kind === 'channel' ? 'teams' : 'chat' });
  if (!convId) return;
  await loadMessages(convId);
  reportUi();
}

/** Open a conversation scrolled to one message. */
export async function openAt(convId: string, target?: MsgRef): Promise<void> {
  await selectConversation(convId);
  if (!target) return;
  const context = await core.invoke('messages.context', { convId, target });
  mergeInto(convId, context);
  // A reply in a channel thread: open its thread and point at the post.
  const hit = context.find((m) => m.author === target.author && m.seq === target.seq);
  if (hit?.thread && useApp.getState().conversations[convId]?.kind === 'channel') {
    await loadThread(convId, hit.thread);
    useApp.setState({ focusMessage: { convId, id: `${hit.thread.author}:${hit.thread.seq}` } });
    return;
  }
  useApp.setState({ focusMessage: { convId, id: `${target.author}:${target.seq}` } });
}

export async function loadOlder(convId: string): Promise<number> {
  const first = useApp.getState().messages[convId]?.[0];
  if (!first) return 0;
  const older = await core.invoke('messages.list', {
    convId,
    limit: 200,
    before: { hlc: first.hlc, author: first.author },
    ...(useApp.getState().conversations[convId]?.kind === 'channel' && { rootsOnly: true }),
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
