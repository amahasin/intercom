import type { ReactNode } from 'react';
import {
  Button,
  makeStyles,
  mergeClasses,
  Text,
  tokens,
  Tooltip,
} from '@fluentui/react-components';
import { Dismiss16Regular } from '@fluentui/react-icons';

/**
 * How a call says what is going on, in two places that each have one job:
 *
 *  - `Pill`: what is true of the call for as long as it is (recording, sharing, hosting). Small,
 *    one or two words, never cut off; the whole sentence is in its tooltip. They sit beside the
 *    timer in the control bar.
 *  - `NoticeRow`: something to read or answer (remote control, on hold, reconnecting, an error).
 *    A card in the pane at the right of the call, above the people (or, with no such pane, in a
 *    corner of the picture): the sentence wraps and its buttons are under it at full width. The
 *    shared picture is never made smaller for a notice.
 */

const usePillStyles = makeStyles({
  pill: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalXS,
    flex: 'none',
    minHeight: '24px',
    padding: `0 ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusCircular,
    background: tokens.colorNeutralBackground5,
    color: tokens.colorNeutralForeground1,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    whiteSpace: 'nowrap',
    // Narrow windows keep the icon (or dot) and drop the word: the tooltip still says it.
    '@media (max-width: 760px)': { '& .om-pill-text': { display: 'none' } },
  },
  recording: {
    background: tokens.colorPaletteRedBackground3,
    color: tokens.colorNeutralForegroundOnBrand,
  },
  live: { background: tokens.colorBrandBackground2, color: tokens.colorBrandForeground2 },
  dot: {
    width: '8px',
    height: '8px',
    borderRadius: tokens.borderRadiusCircular,
    background: 'currentColor',
    flex: 'none',
    animationName: {
      '0%': { opacity: 1 },
      '50%': { opacity: 0.35 },
      '100%': { opacity: 1 },
    },
    animationDuration: '1.6s',
    animationIterationCount: 'infinite',
    '@media (prefers-reduced-motion: reduce)': { animationName: 'none' },
  },
  hidden: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    overflow: 'hidden',
    clip: 'rect(0 0 0 0)',
    whiteSpace: 'nowrap',
  },
});

/** A short status beside the timer. `title` is the whole sentence (tooltip and screen readers). */
export function Pill({
  tone,
  icon,
  dot,
  label,
  title,
  testId,
  extraText,
}: {
  tone?: 'recording' | 'live';
  icon?: ReactNode;
  dot?: boolean;
  label: string;
  title: string;
  testId: string;
  /** Text for screen readers (and tests) beyond the label. */
  extraText?: string;
}) {
  const s = usePillStyles();
  return (
    <Tooltip content={title} relationship="description" withArrow>
      <div
        className={mergeClasses(
          s.pill,
          tone === 'recording' && s.recording,
          tone === 'live' && s.live,
        )}
        role="status"
        tabIndex={0}
        data-testid={testId}
      >
        {dot && <span className={s.dot} aria-hidden="true" />}
        {icon}
        <span className="om-pill-text">{label}</span>
        <span className={s.hidden}>{extraText ?? title}</span>
      </div>
    </Tooltip>
  );
}

const useRowStyles = makeStyles({
  // The cards stack in the pane at the right of the call (see CallStage), above the people, so
  // the shared picture never gives up any room. It takes none at all while there is nothing to say.
  dock: {
    flex: 'none',
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalS,
    ':empty': { display: 'none' },
  },
  // With no pane (no screen shared): a small stack over a corner of the picture, out of the layout.
  float: {
    position: 'absolute',
    top: tokens.spacingVerticalM,
    right: tokens.spacingHorizontalM,
    zIndex: 5,
    width: '300px',
    maxWidth: `calc(100% - 2 * ${tokens.spacingHorizontalM})`,
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalS,
    ':empty': { display: 'none' },
  },
  row: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusLarge,
    borderLeft: `4px solid ${tokens.colorBrandStroke1}`,
    background: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    boxShadow: tokens.shadow8,
    animationName: {
      from: { opacity: 0, transform: 'translateY(-4px)' },
      to: { opacity: 1, transform: 'translateY(0)' },
    },
    animationDuration: '160ms',
    '@media (prefers-reduced-motion: reduce)': { animationName: 'none' },
  },
  // Someone has a hand on a screen, yours or theirs: the one thing that must not be missed.
  live: {
    borderLeftColor: tokens.colorPaletteMarigoldBorder2,
    background: tokens.colorPaletteMarigoldBackground2,
  },
  warn: {
    borderLeftColor: tokens.colorPaletteRedBorder2,
    background: tokens.colorPaletteRedBackground1,
  },
  head: { display: 'flex', alignItems: 'flex-start', columnGap: tokens.spacingHorizontalS },
  icon: { display: 'inline-flex', flex: 'none', fontSize: '20px', marginTop: '1px' },
  text: { flex: 1, minWidth: 0, overflowWrap: 'anywhere' },
  // Buttons share the card's width: easy to hit, whatever the wording.
  actions: {
    display: 'flex',
    columnGap: tokens.spacingHorizontalS,
    '& > *': { flexGrow: 1 },
  },
  dismiss: { flex: 'none', marginTop: '-4px', marginRight: '-6px' },
});

/**
 * Where the cards go. `dock` is the top of the pane beside a shared screen; `float` is a corner of
 * the picture, for when there is no such pane. Neither changes the size of the picture.
 */
export function Notices({ variant, children }: { variant: 'dock' | 'float'; children: ReactNode }) {
  const s = useRowStyles();
  return (
    <div className={variant === 'dock' ? s.dock : s.float} data-testid="call-notices">
      {children}
    </div>
  );
}

/** One thing to read or answer: its sentence, and under it its buttons, at the card's full width. */
export function NoticeRow({
  tone,
  icon,
  actions,
  onDismiss,
  dismissLabel,
  role,
  testId,
  children,
}: {
  tone?: 'live' | 'warn';
  icon?: ReactNode;
  actions?: ReactNode;
  /** For what only has to be read: a small close button beside the sentence. */
  onDismiss?: () => void;
  dismissLabel?: string;
  role?: 'status' | 'alert' | 'alertdialog';
  testId: string;
  children: ReactNode;
}) {
  const s = useRowStyles();
  return (
    <div
      className={mergeClasses(s.row, tone === 'live' && s.live, tone === 'warn' && s.warn)}
      role={role ?? (tone === 'warn' ? 'alert' : 'status')}
      data-testid={testId}
    >
      <div className={s.head}>
        {icon && <span className={s.icon}>{icon}</span>}
        <Text className={s.text}>{children}</Text>
        {onDismiss && (
          <Button
            className={s.dismiss}
            size="small"
            appearance="subtle"
            icon={<Dismiss16Regular />}
            aria-label={dismissLabel}
            onClick={onDismiss}
          />
        )}
      </div>
      {actions && <div className={s.actions}>{actions}</div>}
    </div>
  );
}
