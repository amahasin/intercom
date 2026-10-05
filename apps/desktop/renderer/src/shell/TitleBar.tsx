import { Input, makeStyles, Text, tokens, Tooltip } from '@fluentui/react-components';
import { Search20Regular } from '@fluentui/react-icons';
import { strings } from '../strings.ts';
import { Logo } from './Logo.tsx';
import { MeMenu } from './MeMenu.tsx';

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
  search: { WebkitAppRegion: 'no-drag', width: '100%' },
  me: { display: 'flex', justifyContent: 'flex-end', WebkitAppRegion: 'no-drag' },
});

export function TitleBar() {
  const styles = useStyles();
  return (
    <header className={styles.bar}>
      <div className={styles.brand}>
        <Logo size={22} />
        <Text weight="semibold">{strings.appName}</Text>
      </div>
      <Tooltip content={strings.searchUnavailable} relationship="description">
        <Input
          className={styles.search}
          contentBefore={<Search20Regular />}
          placeholder={strings.search}
          aria-label={strings.search}
          appearance="filled-darker"
          disabled
        />
      </Tooltip>
      <div className={styles.me}>
        <MeMenu />
      </div>
    </header>
  );
}
