import { useRef } from 'react';
import {
  Avatar,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  makeStyles,
  Switch,
  Text,
  tokens,
} from '@fluentui/react-components';
import { DeviceSettings } from '../calls/DeviceSettings.tsx';
import { avatarSrc, core, useApp } from '../state.ts';
import { strings } from '../strings.ts';

const useStyles = makeStyles({
  content: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalL },
  row: { display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalM },
  help: { color: tokens.colorNeutralForeground3 },
});

/** Square-crop and shrink a picture to 96x96 PNG on this PC (avatars are capped at 128 KB). */
async function avatarBytes(file: File): Promise<Uint8Array<ArrayBuffer>> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = new OffscreenCanvas(96, 96);
  canvas
    .getContext('2d')!
    .drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      96,
      96,
    );
  return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const styles = useStyles();
  const settings = useApp((s) => s.settings);
  const identity = useApp((s) => s.identity)!;
  const fileInput = useRef<HTMLInputElement>(null);
  const set = async (change: { readReceipts?: boolean; startWithWindows?: boolean }) =>
    useApp.setState({ settings: await core.invoke('settings.set', change) });

  return (
    <Dialog open onOpenChange={(_e, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{strings.settings.title}</DialogTitle>
          <DialogContent className={styles.content}>
            <Field label={strings.settings.avatar}>
              <div className={styles.row}>
                <Avatar
                  name={identity.displayName}
                  size={56}
                  color="colorful"
                  image={avatarSrc(identity.avatarHash)}
                />
                <Button onClick={() => fileInput.current?.click()} data-testid="avatar-choose">
                  {strings.settings.changeAvatar}
                </Button>
                {identity.avatarHash && (
                  <Button
                    appearance="subtle"
                    onClick={() =>
                      void core
                        .invoke('profile.update', { avatarHash: null })
                        .then((v) => useApp.setState({ identity: v }))
                    }
                  >
                    {strings.settings.removeAvatar}
                  </Button>
                )}
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  hidden
                  data-testid="avatar-input"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (!file) return;
                    const data = await avatarBytes(file);
                    useApp.setState({
                      identity: await core.invoke('profile.setAvatar', { data, mime: 'image/png' }),
                    });
                  }}
                />
              </div>
            </Field>
            <div>
              <Switch
                label={strings.settings.readReceipts}
                checked={settings?.readReceipts ?? true}
                onChange={(_e, d) => void set({ readReceipts: d.checked })}
                data-testid="setting-read-receipts"
              />
              <Text size={200} block className={styles.help}>
                {strings.settings.readReceiptsHelp}
              </Text>
            </div>
            <Switch
              label={strings.settings.startWithWindows}
              checked={settings?.startWithWindows ?? true}
              onChange={(_e, d) => void set({ startWithWindows: d.checked })}
            />
            <DeviceSettings />
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" onClick={onClose}>
              {strings.settings.close}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
