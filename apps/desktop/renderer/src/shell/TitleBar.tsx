import { Button, makeStyles, Text, tokens } from '@fluentui/react-components';
import { ChevronLeft20Regular, ChevronRight20Regular, Home20Regular } from '@fluentui/react-icons';
import { strings } from '../strings.ts';
import { Logo } from './Logo.tsx';
import { MeMenu } from './MeMenu.tsx';
import { SearchBox } from '../search/SearchBox.tsx';
import { selectConversation } from '../state.ts';
import { goBack, goForward, useNav } from './nav.ts';

const useStyles = makeStyles({
  bar: {
    height: '48px',
    display: 'grid',
    gridTemplateColumns: '1fr minmax(240px, 560px) 1fr',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalM,
    paddingLeft: tokens.spacingHorizontalM,
    // Leave room for the native window controls drawn by the title bar overlay.
    paddingRight: 'calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw) + 8px)',
    WebkitAppRegion: 'drag',
  },
  brand: { display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalS },
  arrows: { display: 'flex', WebkitAppRegion: 'no-drag' },
  search: { WebkitAppRegion: 'no-drag', width: '100%' },
  // The empty space right of the search box drags the window like the left side does; only the
  // avatar button inside it (see MeMenu) takes clicks.
  me: { display: 'flex', justifyContent: 'flex-end' },
});

export function TitleBar() {
  const styles = useStyles();
  const canBack = useNav((s) => s.canBack);
  const canForward = useNav((s) => s.canForward);
  return (
    <header className={styles.bar}>
      <div className={styles.brand}>
        <Logo size={22} />
        <Text weight="semibold">{strings.appName}</Text>
        <div className={styles.arrows}>
          <Button
            appearance="subtle"
            size="small"
            icon={<Home20Regular />}
            aria-label={strings.nav.home}
            title={strings.nav.home}
            onClick={() => void selectConversation(undefined)}
            data-testid="nav-home"
          />
          <Button
            appearance="subtle"
            size="small"
            icon={<ChevronLeft20Regular />}
            aria-label={strings.nav.back}
            title={strings.nav.back}
            disabled={!canBack}
            onClick={() => void goBack()}
            data-testid="nav-back"
          />
          <Button
            appearance="subtle"
            size="small"
            icon={<ChevronRight20Regular />}
            aria-label={strings.nav.forward}
            title={strings.nav.forward}
            disabled={!canForward}
            onClick={() => void goForward()}
            data-testid="nav-forward"
          />
        </div>
      </div>
      <SearchBox />
      <div className={styles.me}>
        <MeMenu />
      </div>
    </header>
  );
}
