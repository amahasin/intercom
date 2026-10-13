import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { FluentProvider } from '@fluentui/react-components';
import { App } from './App.tsx';
import { CallWindow } from './calls/CallWindow.tsx';
import { initCalls } from './calls/engine.ts';
import { IncomingWindow } from './calls/IncomingWindow.tsx';
import { BOUND_CALL, ROLE } from './role.ts';
import { bootstrap } from './state.ts';
import { useSystemTheme } from './theme.ts';

function Root() {
  const { theme } = useSystemTheme();
  return (
    <FluentProvider theme={theme}>
      {ROLE === 'call' ? <CallWindow /> : ROLE === 'incoming' ? <IncomingWindow /> : <App />}
    </FluentProvider>
  );
}

// Calls start once the identity is known (the engine needs this user's id). A call window
// runs the media of its call; the other windows only follow what the calls are doing.
void bootstrap().then(() => initCalls(ROLE, BOUND_CALL));
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
