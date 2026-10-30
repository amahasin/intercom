import {
  PRESENCE_LABELS,
  type ManualPresenceState,
  type PresenceState,
} from '@officemesh/protocol';

/**
 * What the tray menu holds, as plain data: the main process turns it into a native menu, and tests
 * read it as it is. A click is named by its `id`.
 */
export interface TrayItem {
  id: string;
  label: string;
  enabled?: boolean;
  /** A status the user can pick (a radio), shown as checked when it is the one picked. */
  checked?: boolean;
  /** The status dot to draw beside it. */
  dot?: PresenceState;
  /** The app's own icon beside it. */
  app?: boolean;
  separator?: boolean;
  children?: TrayItem[];
}

export interface TrayWho {
  name: string;
  presence: PresenceState;
  manual: ManualPresenceState;
  inCall: boolean;
}

/** The statuses a person can pick, in the order of the menu. */
export const PICKABLE: ManualPresenceState[] = ['available', 'busy', 'dnd', 'brb', 'away'];

export const IN_A_CALL = 'In a call';

const sep = (id: string): TrayItem => ({ id, label: '', separator: true });

export function trayModel(who: TrayWho | undefined, unread: number): TrayItem[] {
  const shown: PresenceState = who?.inCall ? 'busy' : (who?.presence ?? 'offline');
  const shownLabel = who?.inCall ? IN_A_CALL : who ? PRESENCE_LABELS[who.presence] : 'Starting…';
  return [
    // Who this is: the app's icon and the name, which opens the window.
    { id: 'header', label: who?.name || 'InterCom', app: true },
    {
      id: 'status',
      label: shownLabel,
      dot: shown,
      enabled: who !== undefined,
      children: [
        ...PICKABLE.map((state): TrayItem => ({
          id: `presence:${state}`,
          label: PRESENCE_LABELS[state],
          dot: state,
          checked: who?.manual === state,
        })),
        sep('status-sep'),
        { id: 'status-reset', label: 'Reset status' },
      ],
    },
    sep('sep-1'),
    { id: 'open', label: 'Open InterCom' },
    ...(unread > 0
      ? [{ id: 'unread', label: unread === 1 ? '1 unread message' : `${unread} unread messages` }]
      : []),
    sep('sep-2'),
    { id: 'quit', label: 'Quit InterCom' },
  ];
}

/** The tooltip over the icon: who, how they show, and what is waiting (Windows cuts it at 127 characters). */
export function trayTooltip(who: TrayWho | undefined, unread: number): string {
  const parts = ['InterCom'];
  if (who)
    parts[0] = `InterCom: ${who.name}, ${who.inCall ? IN_A_CALL : PRESENCE_LABELS[who.presence]}`;
  if (unread > 0) parts.push(unread === 1 ? '1 unread' : `${unread} unread`);
  return parts.join(' · ').slice(0, 127);
}
