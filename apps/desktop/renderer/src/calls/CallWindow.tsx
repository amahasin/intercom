import { useEffect, useRef } from 'react';
import { makeStyles, Spinner, Text, tokens } from '@fluentui/react-components';
import { Logo } from '../shell/Logo.tsx';
import { displayName, useApp } from '../state.ts';
import { strings } from '../strings.ts';
import { CallEndedScreen } from './CallEnded.tsx';
import { CallStage } from './CallStage.tsx';
import { useCall } from './engine.ts';

const useStyles = makeStyles({
  root: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    background: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground1,
  },
  // The title bar: draggable, with room on the right for the window buttons main draws.
  titlebar: {
    flex: 'none',
    height: '40px',
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: '150px',
    WebkitAppRegion: 'drag',
  },
  title: { minWidth: 0 },
  body: { flex: 1, minHeight: 0, display: 'flex' },
  centre: { flex: 1, display: 'grid', placeItems: 'center' },
});

/** The window of one call or meeting: the call itself, then how it ended. */
export function CallWindow() {
  const s = useStyles();
  const call = useCall((st) => st.call);
  const ending = useCall((st) => st.ending);
  const selfId = useApp((st) => st.identity?.userId);
  const title = call
    ? call.participants
        .filter((p) => p.userId !== selfId)
        .map((p) => displayName(p.userId))
        .join(', ') || strings.calls.videoCall
    : (ending?.who ?? '');
  useEffect(() => {
    document.title = title ? `${strings.appName} - ${title}` : strings.appName;
  }, [title]);
  // The window goes away once "Call ended" has been shown.
  const hadEnding = useRef(false);
  useEffect(() => {
    if (ending) hadEnding.current = true;
    else if (hadEnding.current) window.officemeshWindow?.close();
  }, [ending]);
  return (
    <div className={s.root}>
      <div className={s.titlebar}>
        <Logo size={18} />
        <Text size={200} weight="semibold" className={s.title} truncate wrap={false}>
          {title ? `${strings.appName} - ${title}` : strings.appName}
        </Text>
      </div>
      <div className={s.body}>
        {call ? (
          <CallStage />
        ) : ending ? (
          <CallEndedScreen />
        ) : (
          <div className={s.centre}>
            <Spinner label={strings.status.starting} />
          </div>
        )}
      </div>
    </div>
  );
}
