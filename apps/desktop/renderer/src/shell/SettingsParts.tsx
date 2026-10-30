/**
 * The pieces every Settings page is made of, so they all look alike: a **section** (a card with a
 * small icon, a title and a line saying what it is for), **rows** inside it (what the setting is
 * on the left, its control on the right, a hairline between rows), and a **note** for a remark.
 */
import type { JSX, ReactNode } from 'react';
import { makeStyles, mergeClasses, Text, tokens } from '@fluentui/react-components';

const useStyles = makeStyles({
  section: {
    display: 'flex',
    flexDirection: 'column',
    // In a page that scrolls, a card keeps its height instead of being squeezed to fit.
    flexShrink: 0,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    boxShadow: tokens.shadow2,
    overflow: 'hidden',
  },
  head: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalXL} ${tokens.spacingVerticalS}`,
  },
  chip: {
    flexShrink: 0,
    width: '32px',
    height: '32px',
    display: 'grid',
    placeItems: 'center',
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground2,
  },
  headText: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    flexGrow: 1,
    '& > h3': { margin: 0 },
  },
  aside: { flexShrink: 0 },
  muted: { color: tokens.colorNeutralForeground3 },
  body: {
    display: 'flex',
    flexDirection: 'column',
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalXL} ${tokens.spacingVerticalL}`,
  },
  // Rows in a section: a hairline between them, room above and below each.
  rows: {
    display: 'flex',
    flexDirection: 'column',
    '& > * + *': {
      borderTop: `1px solid ${tokens.colorNeutralStroke3}`,
    },
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalXL}`,
    padding: `${tokens.spacingVerticalM} 0`,
  },
  rowText: { display: 'flex', flexDirection: 'column', flex: '1 1 240px', minWidth: 0 },
  rowControl: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  // The text above, and not given a height of its own (it would be 240px tall in a column).
  stacked: {
    flexDirection: 'column',
    alignItems: 'stretch',
    '& > span': { flexBasis: 'auto', flexGrow: 0 },
  },
  // Under the text and as wide as the card: an input, a list, a row of buttons.
  stackedControl: { width: '100%', flexDirection: 'column', alignItems: 'stretch' },
  note: {
    display: 'flex',
    alignItems: 'flex-start',
    columnGap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2,
  },
  noteIcon: { flexShrink: 0, color: tokens.colorNeutralForeground3, paddingTop: '2px' },
});

/** A card with an icon, a title and a line about it; its content goes in `children`. */
export function Section({
  icon,
  title,
  description,
  aside,
  children,
  testId,
}: {
  icon?: JSX.Element;
  title: string;
  description?: string;
  /** Something at the right of the heading (a badge, a button). */
  aside?: ReactNode;
  children?: ReactNode;
  testId?: string;
}) {
  const s = useStyles();
  return (
    <section className={s.section} data-testid={testId}>
      <header className={s.head}>
        {icon && (
          <span className={s.chip} aria-hidden="true">
            {icon}
          </span>
        )}
        <span className={s.headText}>
          <Text as="h3" size={400} weight="semibold">
            {title}
          </Text>
          {description && (
            <Text size={200} className={s.muted}>
              {description}
            </Text>
          )}
        </span>
        {aside && <span className={s.aside}>{aside}</span>}
      </header>
      {children && <div className={s.body}>{children}</div>}
    </section>
  );
}

/** Rows one under another, with a hairline between them. */
export function Rows({ children }: { children: ReactNode }) {
  return <div className={useStyles().rows}>{children}</div>;
}

/**
 * One setting: what it is (and a line about it) at the left, its control at the right. `stacked`
 * puts the control under the text, full width (for an input or a list).
 */
export function Row({
  title,
  description,
  children,
  stacked,
  testId,
}: {
  title?: string;
  description?: string;
  children?: ReactNode;
  stacked?: boolean;
  testId?: string;
}) {
  const s = useStyles();
  return (
    <div className={mergeClasses(s.row, stacked && s.stacked)} data-testid={testId}>
      {(title || description) && (
        <span className={s.rowText}>
          {title && <Text weight="semibold">{title}</Text>}
          {description && (
            <Text size={200} className={s.muted}>
              {description}
            </Text>
          )}
        </span>
      )}
      {children && (
        <span className={mergeClasses(s.rowControl, stacked && s.stackedControl)}>{children}</span>
      )}
    </div>
  );
}

/** A remark: a quiet panel with an icon, for what is good to know and not a setting. */
export function Note({
  icon,
  children,
  testId,
}: {
  icon?: JSX.Element;
  children: ReactNode;
  testId?: string;
}) {
  const s = useStyles();
  return (
    <div className={s.note} data-testid={testId}>
      {icon && (
        <span className={s.noteIcon} aria-hidden="true">
          {icon}
        </span>
      )}
      <Text size={200}>{children}</Text>
    </div>
  );
}
