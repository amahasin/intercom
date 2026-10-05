import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { FluentProvider } from '@fluentui/react-components';
import { App } from './App.tsx';
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

void bootstrap();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
