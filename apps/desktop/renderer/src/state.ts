import { create } from 'zustand';
import {
  createIpcClient,
  type AppInfo,
  type CoreStatus,
  type IdentityView,
} from '@officemesh/protocol/ipc';

export type RailId = 'activity' | 'chat' | 'teams' | 'calendar' | 'calls' | 'files';

interface AppState {
  status: CoreStatus;
  identity: IdentityView | undefined;
  info: AppInfo | undefined;
  rail: RailId;
  setRail: (rail: RailId) => void;
}

export const useApp = create<AppState>((set) => ({
  status: { state: 'starting' },
  identity: undefined,
  info: undefined,
  rail: 'chat',
  setRail: (rail) => set({ rail }),
}));

/** The renderer's only channel to the core. */
export const core = createIpcClient({
  send: (frame) => window.officemesh.send(frame),
  onFrame: (listener) => window.officemesh.onFrame(listener),
});

export async function bootstrap(): Promise<void> {
  core.on('core.status', (status) => useApp.setState({ status }));
  core.on('identity.changed', (identity) => useApp.setState({ identity }));
  try {
    const [identity, info] = await Promise.all([
      core.invoke('identity.get', {}),
      core.invoke('app.info', {}),
    ]);
    useApp.setState({ identity, info, status: { state: 'ready' } });
  } catch (err) {
    useApp.setState({
      status: { state: 'error', message: err instanceof Error ? err.message : String(err) },
    });
  }
}
