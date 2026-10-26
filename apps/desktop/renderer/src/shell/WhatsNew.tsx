import { useEffect } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  makeStyles,
  mergeClasses,
  Text,
  tokens,
} from '@fluentui/react-components';
import { Dismiss20Regular, Sparkle20Filled } from '@fluentui/react-icons';
import { create } from 'zustand';
import { hasUnseen, notesSince, type ReleaseNote } from '../releaseNotes.ts';
import { core, useApp } from '../state.ts';
import { strings } from '../strings.ts';

const useStyles = makeStyles({
  surface: { width: 'min(560px, 94vw)', maxWidth: '560px' },
  title: { display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalS },
  spark: { color: tokens.colorBrandForeground1, flex: 'none' },
  // The notes scroll inside the dialog; the title and the button stay in view.
  content: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalL,
    maxHeight: 'min(56vh, 460px)',
    overflowY: 'auto',
    paddingRight: tokens.spacingHorizontalS,
  },
  release: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM },
  version: {
    color: tokens.colorNeutralForeground3,
    paddingBottom: tokens.spacingVerticalXXS,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  group: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalS },
  tag: {
    alignSelf: 'flex-start',
    padding: `0 ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusCircular,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase300,
    fontWeight: tokens.fontWeightSemibold,
  },
  tagAdded: { background: tokens.colorBrandBackground2, color: tokens.colorBrandForeground2 },
  tagImproved: {
    background: tokens.colorNeutralBackground5,
    color: tokens.colorNeutralForeground1,
  },
  tagFixed: {
    background: tokens.colorPaletteMarigoldBackground2,
    color: tokens.colorNeutralForeground1,
  },
  item: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: '2px',
    paddingLeft: tokens.spacingHorizontalM,
    borderLeft: `2px solid ${tokens.colorNeutralStroke2}`,
  },
  text: { color: tokens.colorNeutralForeground2 },
});

/** Whether the dialog is open (it opens by itself after an update, and from Settings > About). */
const useWhatsNew = create<{ open: boolean; all: boolean }>(() => ({ open: false, all: false }));

/** The version this session has already dealt with (opened for, or passed over), so once only. */
let handled = '';

/** Show the recent notes again (the button in Settings > About). */
export function openWhatsNew(): void {
  useWhatsNew.setState({ open: true, all: true });
}

/**
 * The first start after an update: what is new, once. A profile that has run before and last saw
 * an older version (or none that is known) is shown the notes of the releases since; a new one is
 * not (the core marks it as having seen this version). It is only counted as seen when closed, so
 * quitting with it open shows it again. A version with no notes is passed over without a word.
 */
export function WhatsNewHost() {
  const s = useStyles();
  const ready = useApp((st) => st.identity !== undefined);
  const settings = useApp((st) => st.settings);
  const current = useApp((st) => st.info?.appVersion ?? '');
  const { open, all } = useWhatsNew();
  const seen = settings?.whatsNewSeen;
  const waiting = ready && seen !== undefined && hasUnseen(seen, current);

  // Something to show: open. Nothing to say about this version: note it as seen and say nothing.
  useEffect(() => {
    if (!waiting || handled === current) return;
    handled = current;
    if (notesSince(seen!, current).length > 0) useWhatsNew.setState({ open: true, all: false });
    else void markSeen(current);
  }, [waiting, seen, current]);

  if (!open) return null;
  const notes = notesSince(all ? '' : (seen ?? ''), current, all ? 3 : 4);
  const shown = notes.length > 0 ? notes : notesSince('', current, 1);
  const close = () => {
    useWhatsNew.setState({ open: false, all: false });
    if (waiting) void markSeen(current);
  };
  return (
    <Dialog open onOpenChange={(_e, d) => !d.open && close()}>
      <DialogSurface className={s.surface} data-testid="whats-new">
        <DialogBody>
          <DialogTitle
            action={
              <Button
                appearance="subtle"
                aria-label={strings.whatsNew.close}
                icon={<Dismiss20Regular />}
                onClick={close}
                data-testid="whats-new-x"
              />
            }
          >
            <span className={s.title}>
              <Sparkle20Filled className={s.spark} />
              {strings.whatsNew.title(current)}
            </span>
          </DialogTitle>
          <DialogContent className={s.content}>
            <Text className={s.text}>{strings.whatsNew.intro}</Text>
            {shown.map((n) => (
              <Release key={n.version} note={n} heading={shown.length > 1} />
            ))}
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" onClick={close} data-testid="whats-new-close">
              {strings.whatsNew.gotIt}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/** Note that this version's notes have been seen (the core keeps it with the other settings). */
async function markSeen(version: string): Promise<void> {
  try {
    const settings = await core.invoke('settings.set', { whatsNewSeen: version });
    useApp.setState({ settings });
  } catch {
    // Not saved: it is shown again next time, which is harmless.
  }
}

function Release({ note, heading }: { note: ReleaseNote; heading: boolean }) {
  const s = useStyles();
  const groups: Array<[string, string, ReleaseNote['added']]> = [
    [strings.whatsNew.added, s.tagAdded, note.added],
    [strings.whatsNew.improved, s.tagImproved, note.improved],
    [strings.whatsNew.fixed, s.tagFixed, note.fixed],
  ];
  return (
    <section className={s.release} data-testid="whats-new-release" data-version={note.version}>
      {heading && (
        <Text size={300} weight="semibold" className={s.version}>
          {strings.whatsNew.earlier(note.version)}
        </Text>
      )}
      {groups
        .filter(([, , items]) => items.length > 0)
        .map(([label, tone, items]) => (
          <div key={label} className={s.group}>
            <span className={mergeClasses(s.tag, tone)}>{label}</span>
            {items.map((i) => (
              <div key={i.title} className={s.item}>
                <Text weight="semibold">{i.title}</Text>
                <Text size={200} className={s.text}>
                  {i.text}
                </Text>
              </div>
            ))}
          </div>
        ))}
    </section>
  );
}
