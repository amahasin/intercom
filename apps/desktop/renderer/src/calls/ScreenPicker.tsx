import { useEffect, useState } from 'react';
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
  Spinner,
  Tab,
  TabList,
  Text,
  tokens,
} from '@fluentui/react-components';
import type { ScreenSource } from '@officemesh/protocol/ipc';
import { core, useApp } from '../state.ts';
import { strings } from '../strings.ts';
import { startShare, useCall } from './engine.ts';

const useStyles = makeStyles({
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
    gap: tokens.spacingHorizontalM,
    maxHeight: '420px',
    overflowY: 'auto',
    paddingTop: tokens.spacingVerticalM,
  },
  source: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalXS,
    padding: tokens.spacingHorizontalS,
    border: `2px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground1,
    cursor: 'pointer',
    textAlign: 'left',
    color: tokens.colorNeutralForeground1,
  },
  chosen: { border: `2px solid ${tokens.colorBrandStroke1}` },
  thumb: {
    width: '100%',
    aspectRatio: '16 / 9',
    objectFit: 'contain',
    background: tokens.colorNeutralBackground3,
  },
  name: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
});

/** Pick a screen or window to share, with thumbnails (plan section 9). */
export function ScreenPicker({ onClose }: { onClose: () => void }) {
  const s = useStyles();
  const [sources, setSources] = useState<ScreenSource[] | undefined>();
  const [kind, setKind] = useState<'screen' | 'window'>('screen');
  const [chosen, setChosen] = useState<ScreenSource | undefined>();
  const selfId = useApp((st) => st.identity?.userId);
  const otherSharing = useCall((st) =>
    st.call?.participants.some((p) => p.sharing && p.userId !== selfId),
  );
  useEffect(() => {
    void core.invoke('screen.sources', {}).then(setSources, () => setSources([]));
  }, []);
  const shown = (sources ?? []).filter((x) => x.kind === kind);
  return (
    <Dialog open onOpenChange={(_e, d) => !d.open && onClose()}>
      <DialogSurface style={{ maxWidth: 760 }}>
        <DialogBody>
          <DialogTitle>{strings.calls.pickTitle}</DialogTitle>
          <DialogContent>
            <TabList
              selectedValue={kind}
              onTabSelect={(_e, d) => setKind(d.value as 'screen' | 'window')}
            >
              <Tab value="screen">{strings.calls.screens}</Tab>
              <Tab value="window">{strings.calls.windows}</Tab>
            </TabList>
            {!sources ? (
              <Spinner size="small" />
            ) : (
              <div className={s.grid} data-testid="screen-sources">
                {shown.map((src) => (
                  <button
                    key={src.id}
                    type="button"
                    className={mergeClasses(s.source, chosen?.id === src.id && s.chosen)}
                    onClick={() => setChosen(src)}
                    onDoubleClick={() => setChosen(src)}
                    data-testid="screen-source"
                  >
                    {src.thumbnail && <img className={s.thumb} src={src.thumbnail} alt="" />}
                    <Text size={200} className={s.name}>
                      {src.name}
                    </Text>
                  </button>
                ))}
              </div>
            )}
            {otherSharing && (
              <Text size={200} block style={{ marginTop: 8 }}>
                {strings.calls.replaceShare}
              </Text>
            )}
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose}>{strings.me.cancel}</Button>
            <Button
              appearance="primary"
              disabled={!chosen}
              data-testid="screen-share-start"
              onClick={() => {
                if (chosen) void startShare(chosen);
                onClose();
              }}
            >
              {strings.calls.shareButton}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
