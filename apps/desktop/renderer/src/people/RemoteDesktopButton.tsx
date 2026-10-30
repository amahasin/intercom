/**
 * "Remote Desktop Connection" on a colleague's page: starts Windows' own program at their PC. A
 * user name and password can be saved for each PC, and then it connects without asking. The button
 * only starts the program; the sign-in is kept on this PC and never shown again.
 */
import { useCallback, useEffect, useState } from 'react';
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
import { Desktop20Regular, Key20Regular } from '@fluentui/react-icons';
import type { PersonView, RemoteDesktopSaved } from '@officemesh/protocol/ipc';
import { core, displayName } from '../state.ts';
import { strings } from '../strings.ts';

const useStyles = makeStyles({
  surface: { width: '440px', maxWidth: 'calc(100vw - 32px)' },
  content: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM },
  muted: { color: tokens.colorNeutralForeground3 },
  error: { color: tokens.colorPaletteRedForeground1 },
});

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function RemoteDesktopButton({ person }: { person: PersonView }) {
  const t = strings.remoteDesktop;
  const [saved, setSaved] = useState<RemoteDesktopSaved>();
  const [editing, setEditing] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);

  // What is saved for this colleague (and where they are reached), asked again when they change.
  const load = useCallback(() => {
    void core.invoke('remoteDesktop.get', { userId: person.userId }).then(setSaved);
  }, [person.userId]);
  useEffect(load, [load, person.address]);

  const connect = async () => {
    setBusy(true);
    try {
      await core.invoke('remoteDesktop.connect', { userId: person.userId });
    } catch (err) {
      setProblem(reason(err));
    } finally {
      setBusy(false);
    }
  };

  const known = saved?.address !== undefined;
  return (
    <>
      <Tooltip
        content={saved?.saved ? t.tipSaved(saved.username ?? '') : t.tipNotSaved}
        relationship="description"
      >
        <Button
          icon={<Desktop20Regular />}
          disabled={busy || (saved !== undefined && !known)}
          onClick={() => void connect()}
          data-testid="rdp-connect"
        >
          {t.button}
        </Button>
      </Tooltip>
      <Tooltip content={saved?.saved ? t.signInEdit : t.signInSave} relationship="label">
        <Button
          appearance={saved?.saved ? 'subtle' : 'subtle'}
          icon={<Key20Regular />}
          onClick={() => setEditing(true)}
          data-testid="rdp-signin"
          data-saved={saved?.saved ? 'true' : 'false'}
        />
      </Tooltip>

      {editing && (
        <SignInDialog
          person={person}
          saved={saved}
          onClose={() => setEditing(false)}
          onChanged={(next) => setSaved(next)}
          onConnect={connect}
        />
      )}

      {problem && (
        <Dialog open onOpenChange={(_e, d) => !d.open && setProblem(undefined)}>
          <DialogSurface data-testid="rdp-problem">
            <DialogBody>
              <DialogTitle>{t.button}</DialogTitle>
              <DialogContent>
                <Text>{problem}</Text>
              </DialogContent>
              <DialogActions>
                <Button appearance="primary" onClick={() => setProblem(undefined)}>
                  {strings.me.cancel}
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      )}
    </>
  );
}

function SignInDialog({
  person,
  saved,
  onClose,
  onChanged,
  onConnect,
}: {
  person: PersonView;
  saved: RemoteDesktopSaved | undefined;
  onClose: () => void;
  onChanged: (next: RemoteDesktopSaved) => void;
  onConnect: () => Promise<void>;
}) {
  const styles = useStyles();
  const t = strings.remoteDesktop;
  const [address, setAddress] = useState(saved?.custom ? (saved.address ?? '') : '');
  const [username, setUsername] = useState(saved?.username ?? '');
  const [password, setPassword] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();

  // Saving needs a user name, and a password the first time (afterwards it can be left as it is).
  const ready = username.trim() !== '' && (password !== '' || saved?.saved === true);
  const seen = person.address ?? person.machine?.host;

  const save = async (andConnect: boolean) => {
    setWorking(true);
    setError(undefined);
    try {
      const next = await core.invoke('remoteDesktop.save', {
        userId: person.userId,
        address: address.trim(),
        username: username.trim(),
        ...(password !== '' && { password }),
      });
      onChanged(next);
      onClose();
      if (andConnect) await onConnect();
    } catch (err) {
      setError(reason(err));
      setWorking(false);
    }
  };

  const forget = async () => {
    setWorking(true);
    try {
      onChanged(await core.invoke('remoteDesktop.forget', { userId: person.userId }));
      onClose();
    } catch (err) {
      setError(reason(err));
      setWorking(false);
    }
  };

  return (
    <Dialog open onOpenChange={(_e, d) => !d.open && onClose()}>
      <DialogSurface className={styles.surface} data-testid="rdp-dialog">
        <DialogBody>
          <DialogTitle>{t.dialogTitle(displayName(person.userId))}</DialogTitle>
          <DialogContent className={styles.content}>
            <Text size={200} className={styles.muted}>
              {t.dialogHelp}
            </Text>
            <Field label={t.address} hint={seen ? t.addressHint(seen) : t.addressHintNone}>
              <Input
                value={address}
                placeholder={seen ?? ''}
                onChange={(_e, d) => setAddress(d.value)}
                data-testid="rdp-address"
              />
            </Field>
            <Field label={t.username} required>
              <Input
                value={username}
                placeholder={t.usernamePlaceholder}
                autoComplete="off"
                onChange={(_e, d) => setUsername(d.value)}
                data-testid="rdp-username"
              />
            </Field>
            <Field label={t.password} required={!saved?.saved}>
              <Input
                type="password"
                value={password}
                placeholder={saved?.saved ? t.passwordSaved : ''}
                autoComplete="new-password"
                onChange={(_e, d) => setPassword(d.value)}
                data-testid="rdp-password"
              />
            </Field>
            {error && (
              <Text className={styles.error} role="alert" data-testid="rdp-error">
                {error}
              </Text>
            )}
          </DialogContent>
          <DialogActions>
            {saved?.saved && (
              <Button
                appearance="subtle"
                disabled={working}
                onClick={() => void forget()}
                data-testid="rdp-forget"
              >
                {t.forget}
              </Button>
            )}
            <Button appearance="secondary" onClick={onClose}>
              {strings.me.cancel}
            </Button>
            <Button
              disabled={!ready || working}
              onClick={() => void save(false)}
              data-testid="rdp-save"
            >
              {strings.me.save}
            </Button>
            <Button
              appearance="primary"
              disabled={!ready || working}
              onClick={() => void save(true)}
              data-testid="rdp-save-connect"
            >
              {t.saveAndConnect}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
