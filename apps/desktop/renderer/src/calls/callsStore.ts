import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type { CallHistoryItem } from '@officemesh/protocol/ipc';
import { core } from '../state.ts';

export type CallFilter = 'all' | 'missed' | 'incoming' | 'outgoing';

/** What the Calls page shows details of: a colleague, or one call with several people. */
export type CallSelection =
  | { kind: 'person'; userId: string; callId?: string }
  | { kind: 'call'; callId: string }
  | undefined;

export const useCallsView = create<{ filter: CallFilter; selection: CallSelection }>(() => ({
  filter: 'all',
  selection: undefined,
}));

/** Open a colleague's details; `callId` marks which history entry was clicked, if one was. */
export function selectCallsPerson(userId: string, callId?: string): void {
  useCallsView.setState({ selection: { kind: 'person', userId, ...(callId && { callId }) } });
}

/** The call history, kept current while the component using it is on screen. */
export function useCallHistory(): CallHistoryItem[] {
  const [items, setItems] = useState<CallHistoryItem[]>([]);
  useEffect(() => {
    let live = true;
    void core.invoke('calls.history', {}).then((list) => live && setItems(list));
    const off = core.on('calls.history.changed', ({ items: next }) => setItems(next));
    return () => {
      live = false;
      off();
    };
  }, []);
  return items;
}

export function inFilter(call: CallHistoryItem, filter: CallFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'missed':
      return call.outcome === 'missed';
    case 'incoming':
      return call.direction === 'in';
    case 'outgoing':
      return call.direction === 'out';
  }
}

/** How many calls each colleague has been in, most first (for the quick list beside the dial box). */
export function frequentContacts(items: CallHistoryItem[], selfId: string | undefined): string[] {
  const counts = new Map<string, number>();
  for (const c of items)
    for (const id of c.peers) if (id !== selfId) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}
