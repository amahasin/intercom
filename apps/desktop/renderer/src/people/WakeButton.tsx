/**
 * "Wake on LAN" on a colleague's page: sends the wake-up signal to their PC while it is off or asleep.
 * It works only for a PC that is set up for it, and nothing tells whether it did: the PC either
 * starts (and shows up online a moment later) or it does not.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  makeStyles,
  Text,
  tokens,
  Tooltip,
} from '@fluentui/react-components';
import { CheckmarkCircle20Filled, Power20Regular } from '@fluentui/react-icons';
import type { PersonView, WakeInfo } from '@officemesh/protocol/ipc';
import { core, displayName } from '../state.ts';
import { strings } from '../strings.ts';

const useStyles = makeStyles({
  surface: { width: '460px', maxWidth: 'calc(100vw - 32px)' },
  content: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM },
  muted: { color: tokens.colorNeutralForeground3 },
  error: { color: tokens.colorPaletteRedForeground1 },
  mono: { fontFamily: tokens.fontFamilyMonospace },
  sent: { color: tokens.colorPaletteGreenForeground1 },
});

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** How long the button says "Wake-up sent" before it can be pressed again. */
const SENT_FOR_MS = 12_000;

export function WakeButton({
  person,
  editing,
  onEditing,
}: {
  person: PersonView;
  /** The dialog for the hardware address is open (also opened from the More menu). */
  editing: boolean;
  onEditing: (open: boolean) => void;
}) {
  const t = strings.wake;
  const [info, setInfo] = useState<WakeInfo>();
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const load = useCallback(() => {
    void core.invoke('wake.get', { userId: person.userId }).then(setInfo);
  }, [person.userId]);
  // Asked again when their PC reports something new (its page shows the same facts).
  useEffect(load, [load, person.machine?.macs?.join(',')]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const known = info !== undefined && (info.macs.length > 0 || info.custom !== undefined);

  const send = async (custom?: string): Promise<boolean> => {
    setBusy(true);
    try {
      await core.invoke('wake.send', {
        userId: person.userId,
        ...(custom !== undefined && { custom }),
      });
      load();
      setSent(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setSent(false), SENT_FOR_MS);
      return true;
    } catch (err) {
      setProblem(reason(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Tooltip
        content={person.online ? t.alreadyOn : sent ? t.sentTip : t.tip}
        relationship="description"
      >
        <Button
          icon={sent ? <CheckmarkCircle20Filled className="wake-sent" /> : <Power20Regular />}
          disabled={person.online || busy || info === undefined}
          onClick={() => (known ? void send() : onEditing(true))}
          data-testid="wake-button"
          data-sent={sent ? 'true' : 'false'}
        >
          {sent ? t.sent : t.button}
        </Button>
      </Tooltip>

      {editing && (
        <AddressDialog
          person={person}
          info={info}
          onClose={() => onEditing(false)}
          onWake={async (custom) => {
            const ok = await send(custom);
            if (ok) onEditing(false);
            return ok;
          }}
          onForget={async () => {
            await core.invoke('wake.send', { userId: person.userId, custom: '' }).catch(() => {});
            load();
          }}
          problem={problem}
          clearProblem={() => setProblem(undefined)}
        />
      )}

      {problem && !editing && (
        <Dialog open onOpenChange={(_e, d) => !d.open && setProblem(undefined)}>
          <DialogSurface data-testid="wake-problem">
            <DialogBody>
              <DialogTitle>{t.button}</DialogTitle>
              <DialogContent>
                <Text>{problem}</Text>
              </DialogContent>
              <DialogActions>
                <Button appearance="primary" onClick={() => setProblem(undefined)}>
                  {t.close}
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      )}
    </>
  );
}

function AddressDialog({
  person,
  info,
  onClose,
  onWake,
  onForget,
  problem,
  clearProblem,
}: {
  person: PersonView;
  info: WakeInfo | undefined;
  onClose: () => void;
  onWake: (custom: string | undefined) => Promise<boolean>;
  onForget: () => Promise<void>;
  problem: string | undefined;
  clearProblem: () => void;
}) {
  const styles = useStyles();
  const t = strings.wake;
  const [mac, setMac] = useState(info?.custom ?? '');
  const reported = info?.macs ?? [];
  const typed = mac.trim();
  // A reported address is enough to wake them; one is needed only when none is known.
  const canWake = typed !== '' || reported.length > 0 || info?.custom !== undefined;

  return (
    <Dialog open onOpenChange={(_e, d) => !d.open && onClose()}>
      <DialogSurface className={styles.surface} data-testid="wake-dialog">
        <DialogBody>
          <DialogTitle>{t.dialogTitle(displayName(person.userId))}</DialogTitle>
          <DialogContent className={styles.content}>
            <Text size={200} className={styles.muted}>
              {t.help}
            </Text>
            {reported.length > 0 && (
              <Text size={200} data-testid="wake-reported">
                {t.reported} <span className={styles.mono}>{reported.join(', ')}</span>
              </Text>
            )}
            <Field
              label={t.addressLabel}
              hint={reported.length > 0 ? t.addressHintKnown : t.addressHintNone}
            >
              <Input
                value={mac}
                placeholder="AA:BB:CC:DD:EE:FF"
                className={styles.mono}
                onChange={(_e, d) => {
                  setMac(d.value);
                  clearProblem();
                }}
                data-testid="wake-mac"
              />
            </Field>
            {problem && (
              <Text className={styles.error} role="alert" data-testid="wake-error">
                {problem}
              </Text>
            )}
          </DialogContent>
          <DialogActions>
            {info?.custom !== undefined && (
              <Button
                appearance="subtle"
                onClick={() => void onForget().then(() => setMac(''))}
                data-testid="wake-forget"
              >
                {t.forget}
              </Button>
            )}
            <Button appearance="secondary" onClick={onClose}>
              {t.cancel}
            </Button>
            <Button
              appearance="primary"
              disabled={!canWake}
              onClick={() =>
                void onWake(typed !== (info?.custom ?? '') && typed !== '' ? typed : undefined)
              }
              data-testid="wake-send"
            >
              {t.send}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
