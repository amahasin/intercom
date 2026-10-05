import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { FluentProvider } from '@fluentui/react-components';
import { App } from './App.tsx';
import { initCalls } from './calls/engine.ts';
import { bootstrap } from './state.ts';
import { useSystemTheme } from './theme.ts';

function Root() {
  const { theme } = useSystemTheme();
  return (
    <FluentProvider theme={theme}>
      <App />
    </FluentProvider>
  );
}

// Calls start once the identity is known (the engine needs this user's id).
void bootstrap().then(initCalls);
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
