import { Avatar, Badge, Card, makeStyles, Text, Title2, tokens } from '@fluentui/react-components';
import { useApp } from '../state.ts';
import { strings } from '../strings.ts';

const useStyles = makeStyles({
  main: {
    flex: 1,
    overflowY: 'auto',
    background: tokens.colorNeutralBackground1,
    userSelect: 'text',
  },
  inner: {
    maxWidth: '720px',
    margin: '0 auto',
    padding: `${tokens.spacingVerticalXXXL} ${tokens.spacingHorizontalXXL}`,
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalXL,
  },
  hero: { display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalL },
  intro: {
    color: tokens.colorNeutralForeground2,
    marginTop: tokens.spacingVerticalXS,
    marginBottom: 0,
  },
  card: { padding: tokens.spacingHorizontalXL },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'max-content 1fr',
    columnGap: tokens.spacingHorizontalXL,
    rowGap: tokens.spacingVerticalM,
    alignItems: 'baseline',
  },
  label: { color: tokens.colorNeutralForeground3 },
  mono: { fontFamily: tokens.fontFamilyMonospace, wordBreak: 'break-all' },
  words: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS },
  help: { color: tokens.colorNeutralForeground3, gridColumn: '2' },
});

export function Home() {
  const styles = useStyles();
  const identity = useApp((s) => s.identity);
  const info = useApp((s) => s.info);
  if (!identity || !info) return <main className={styles.main} />;
  return (
    <main className={styles.main}>
      <div className={styles.inner}>
        <div className={styles.hero}>
          <Avatar name={identity.displayName} size={72} color="colorful" />
          <div>
            <Title2 as="h2" block>
              {strings.home.welcome(identity.displayName)}
            </Title2>
            <Text as="p" block className={styles.intro}>
              {strings.home.intro}
            </Text>
          </div>
        </div>

        <Card className={styles.card}>
          <Text as="h3" size={400} weight="semibold">
            {strings.home.identityHeading}
          </Text>
          <div className={styles.grid}>
            <Text className={styles.label}>{strings.home.displayName}</Text>
            <Text data-testid="display-name">{identity.displayName}</Text>

            <Text className={styles.label}>{strings.home.userId}</Text>
            <Text className={styles.mono} data-testid="user-id">
              {identity.userId}
            </Text>

            <Text className={styles.label}>{strings.home.safetyPhrase}</Text>
            <div className={styles.words} data-testid="safety-phrase">
              {identity.safetyPhrase.map((word, i) => (
                <Badge key={i} appearance="tint" shape="rounded" size="large">
                  {word}
                </Badge>
              ))}
            </div>
            <Text size={200} className={styles.help}>
              {strings.home.safetyPhraseHelp}
            </Text>

            <Text className={styles.label}>{strings.home.profile}</Text>
            <Text data-testid="profile-name">{info.profile}</Text>

            <Text className={styles.label}>{strings.home.keyProtection}</Text>
            <Text data-testid="key-protection">
              {strings.home.keyProtectionValue[info.keyProtection]}
            </Text>
          </div>
        </Card>
      </div>
    </main>
  );
}
