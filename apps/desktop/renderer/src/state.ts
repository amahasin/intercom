import { create } from 'zustand';
import {
  createIpcClient,
  type AppInfo,
  type ConversationView,
  type CoreStatus,
  type IdentityView,
  type MessageView,
  type NetworkStatus,
  type PersonView,
  type PresenceView,
} from '@officemesh/protocol/ipc';

export type RailId = 'activity' | 'chat' | 'teams' | 'calendar' | 'calls' | 'files';

interface AppState {
  status: CoreStatus;
  identity: IdentityView | undefined;
  info: AppInfo | undefined;
  presence: PresenceView | undefined;
  network: NetworkStatus | undefined;
  people: Record<string, PersonView>;
  conversations: Record<string, ConversationView>;
  /** Loaded messages per conversation, in display order. */
  messages: Record<string, MessageView[]>;
  rail: RailId;
  selectedConv: string | undefined;
  setRail: (rail: RailId) => void;
}

export const useApp = create<AppState>((set) => ({
  status: { state: 'starting' },
  identity: undefined,
  info: undefined,
  presence: undefined,
  network: undefined,
  people: {},
  conversations: {},
  messages: {},
  rail: 'chat',
  selectedConv: undefined,
  setRail: (rail) => set({ rail }),
}));

/** The renderer's only channel to the core. */
export const core = createIpcClient({
  send: (frame) => window.officemesh.send(frame),
  onFrame: (listener) => window.officemesh.onFrame(listener),
});

function byDisplayOrder(a: MessageView, b: MessageView): number {
  return (
    a.hlc.t - b.hlc.t ||
    a.hlc.c - b.hlc.c ||
    (a.author < b.author ? -1 : a.author > b.author ? 1 : 0)
  );
}

/** Insert or replace messages by id, keeping display order. */
function mergeMessages(
  existing: MessageView[] | undefined,
  incoming: MessageView[],
): MessageView[] {
  const byId = new Map((existing ?? []).map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort(byDisplayOrder);
}

function index<T>(items: T[], key: (item: T) => string): Record<string, T> {
  return Object.fromEntries(items.map((i) => [key(i), i]));
}

export async function bootstrap(): Promise<void> {
  core.on('core.status', (status) => useApp.setState({ status }));
  core.on('identity.changed', (identity) => useApp.setState({ identity }));
  core.on('presence.changed', (presence) => useApp.setState({ presence }));
  core.on('network.changed', (network) => useApp.setState({ network }));
  core.on('people.changed', ({ people }) =>
    useApp.setState((s) => ({ people: { ...s.people, ...index(people, (p) => p.userId) } })),
  );
  core.on('conversations.changed', ({ conversations }) =>
    useApp.setState((s) => ({
      conversations: { ...s.conversations, ...index(conversations, (c) => c.convId) },
    })),
  );
  const onMessages = ({ convId, messages }: { convId: string; messages: MessageView[] }) =>
    useApp.setState((s) => {
      // Only conversations whose history is loaded keep live updates; others reload on open.
      if (!s.messages[convId]) return {};
      return { messages: { ...s.messages, [convId]: mergeMessages(s.messages[convId], messages) } };
    });
  core.on('messages.added', onMessages);
  core.on('messages.updated', onMessages);

  try {
    const [identity, info, presence, network, people, conversations] = await Promise.all([
      core.invoke('identity.get', {}),
      core.invoke('app.info', {}),
      core.invoke('presence.get', {}),
      core.invoke('network.status', {}),
      core.invoke('people.list', {}),
      core.invoke('conversations.list', {}),
    ]);
    useApp.setState({
      identity,
      info,
      presence,
      network,
      people: index(people, (p) => p.userId),
      conversations: index(conversations, (c) => c.convId),
      status: { state: 'ready' },
    });
  } catch (err) {
    useApp.setState({
      status: { state: 'error', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

export async function selectConversation(convId: string | undefined): Promise<void> {
  useApp.setState({ selectedConv: convId, rail: 'chat' });
  if (!convId) return;
  const messages = await core.invoke('messages.list', { convId, limit: 200 });
  useApp.setState((s) => ({
    messages: { ...s.messages, [convId]: mergeMessages(s.messages[convId], messages) },
  }));
}

export async function loadOlder(convId: string): Promise<number> {
  const first = useApp.getState().messages[convId]?.[0];
  if (!first) return 0;
  const older = await core.invoke('messages.list', {
    convId,
    limit: 200,
    before: { hlc: first.hlc, author: first.author },
  });
  useApp.setState((s) => ({
    messages: { ...s.messages, [convId]: mergeMessages(s.messages[convId], older) },
  }));
  return older.length;
}

export async function openChatWith(userId: string): Promise<void> {
  const conv = await core.invoke('conversations.openDirect', { userId });
  useApp.setState((s) => ({ conversations: { ...s.conversations, [conv.convId]: conv } }));
  await selectConversation(conv.convId);
}

export async function sendMessage(convId: string, text: string): Promise<void> {
  const message = await core.invoke('messages.send', { convId, text });
  useApp.setState((s) => ({
    messages: { ...s.messages, [convId]: mergeMessages(s.messages[convId], [message]) },
  }));
}

/** A person's name, or a stable placeholder until their profile arrives. */
export function nameOf(person: PersonView | undefined, userId: string): string {
  return person?.displayName ?? `Colleague ${userId.slice(0, 4).toUpperCase()}`;
}
