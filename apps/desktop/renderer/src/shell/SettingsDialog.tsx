import { useRef, useState, type JSX } from 'react';
import {
  Avatar,
  Body1,
  Button,
  Dialog,
  DialogSurface,
  Divider,
  Field,
  Radio,
  RadioGroup,
  Input,
  makeStyles,
  mergeClasses,
  Select,
  Switch,
  Tab,
  TabList,
  Text,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowDownload20Regular,
  ArrowSync20Regular,
  Call20Regular,
  Checkmark16Filled,
  Color20Regular,
  Dismiss20Regular,
  Folder20Regular,
  FolderOpen20Regular,
  Globe20Regular,
  HeartPulse20Regular,
  Info20Regular,
  Person20Regular,
  Settings20Regular,
} from '@fluentui/react-icons';
import { DeviceSettings, NoiseSetting } from '../calls/DeviceSettings.tsx';
import { avatarSrc, core, useApp } from '../state.ts';
import { strings } from '../strings.ts';
import { ACCENTS, buildTheme, inkOn, lookAccent, type Look } from '../theme.ts';
import {
  About,
  DiagnosticsSection,
  Hosting,
  MoveProfile,
  OtherSubnets,
  Updates,
} from './MoreSettings.tsx';

export type SettingsCategory =
  | 'profile'
  | 'general'
  | 'calls'
  | 'files'
  | 'network'
  | 'backup'
  | 'updates'
  | 'diagnostics'
  | 'about';

const CATEGORIES: Array<{ id: SettingsCategory; icon: JSX.Element }> = [
  { id: 'profile', icon: <Person20Regular /> },
  { id: 'general', icon: <Settings20Regular /> },
  { id: 'calls', icon: <Call20Regular /> },
  { id: 'files', icon: <Folder20Regular /> },
  { id: 'network', icon: <Globe20Regular /> },
  { id: 'backup', icon: <ArrowSync20Regular /> },
  { id: 'updates', icon: <ArrowDownload20Regular /> },
  { id: 'diagnostics', icon: <HeartPulse20Regular /> },
  { id: 'about', icon: <Info20Regular /> },
];

const useStyles = makeStyles({
  surface: {
    width: 'min(940px, 94vw)',
    maxWidth: '940px',
    height: 'min(660px, 90vh)',
    padding: 0,
    overflow: 'hidden',
  },
  shell: { display: 'flex', height: '100%', minHeight: 0 },
  nav: {
    width: '236px',
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalM,
    padding: `${tokens.spacingVerticalXL} ${tokens.spacingHorizontalM}`,
    background: tokens.colorNeutralBackground2,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  navTitle: { padding: `0 ${tokens.spacingHorizontalM}` },
  content: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' },
  contentHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalXL}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  pane: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalXL} ${tokens.spacingVerticalXXL}`,
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalL,
  },
  row: { display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalM },
  fields: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalM,
    maxWidth: '460px',
  },
  help: { color: tokens.colorNeutralForeground3 },
  words: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS },
  word: {
    padding: `2px ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground3,
  },
  mono: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200 },
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

function ProfilePane() {
  const styles = useStyles();
  const identity = useApp((s) => s.identity)!;
  const fileInput = useRef<HTMLInputElement>(null);
  const [displayName, setDisplayName] = useState(identity.displayName);
  const [jobTitle, setJobTitle] = useState(identity.jobTitle ?? '');
  const [statusMessage, setStatusMessage] = useState(identity.statusMessage ?? '');
  const [clearAfter, setClearAfter] = useState<'never' | 'hour' | 'today' | 'week'>('never');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();
  const dirty =
    displayName !== identity.displayName ||
    jobTitle !== (identity.jobTitle ?? '') ||
    statusMessage !== (identity.statusMessage ?? '');

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const now = new Date();
      const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
      const expiry =
        clearAfter === 'hour'
          ? now.getTime() + 3_600_000
          : clearAfter === 'today'
            ? endOfDay.getTime()
            : clearAfter === 'week'
              ? endOfDay.getTime() + 6 * 86_400_000
              : null;
      const next = await core.invoke('profile.update', {
        displayName,
        jobTitle,
        statusMessage,
        statusExpiresAt: statusMessage ? expiry : null,
      });
      useApp.setState({ identity: next });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Field label={strings.settings.avatar}>
        <div className={styles.row}>
          <Avatar
            name={identity.displayName}
            size={64}
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
      <div className={styles.fields}>
        <Field label={strings.me.displayName} required>
          <Input
            value={displayName}
            maxLength={64}
            onChange={(_e, d) => {
              setDisplayName(d.value);
              setSaved(false);
            }}
            data-testid="profile-name-input"
          />
        </Field>
        <Field label={strings.me.jobTitle}>
          <Input
            value={jobTitle}
            maxLength={64}
            onChange={(_e, d) => {
              setJobTitle(d.value);
              setSaved(false);
            }}
          />
        </Field>
        <Field label={strings.me.statusMessage}>
          <Input
            value={statusMessage}
            maxLength={280}
            placeholder={strings.me.statusPlaceholder}
            onChange={(_e, d) => {
              setStatusMessage(d.value);
              setSaved(false);
            }}
            data-testid="profile-status-input"
          />
        </Field>
        <Field label={strings.settings.clearAfter}>
          <Select
            value={clearAfter}
            onChange={(_e, d) => setClearAfter(d.value as typeof clearAfter)}
          >
            {(['never', 'hour', 'today', 'week'] as const).map((k) => (
              <option key={k} value={k}>
                {strings.settings.clearOptions[k]}
              </option>
            ))}
          </Select>
        </Field>
        <div className={styles.row}>
          <Button
            appearance="primary"
            disabled={!displayName.trim() || saving || !dirty}
            onClick={() => void save()}
            data-testid="profile-save"
          >
            {strings.me.save}
          </Button>
          {saved && !dirty && (
            <Text size={200} className={styles.help} role="status" data-testid="profile-saved">
              {strings.settings.saved}
            </Text>
          )}
          {error && <Text size={200}>{error}</Text>}
        </div>
      </div>
      <Divider />
      <Field label={strings.settings.identity} hint={strings.settings.identityHelp}>
        <div className={styles.fields}>
          <div className={styles.words} aria-label={strings.person.safetyPhrase}>
            {identity.safetyPhrase.map((w, i) => (
              <span key={`${w}${i}`} className={styles.word}>
                {w}
              </span>
            ))}
          </div>
          <Text className={styles.mono} data-testid="settings-user-id">
            {identity.userId}
          </Text>
        </div>
      </Field>
    </>
  );
}

const useLookStyles = makeStyles({
  looks: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalM },
  look: {
    width: '176px',
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalXS,
    padding: tokens.spacingHorizontalS,
    textAlign: 'left',
    cursor: 'pointer',
    background: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    ':hover': { background: tokens.colorNeutralBackground1Hover },
  },
  lookOn: {
    border: `2px solid ${tokens.colorBrandStroke1}`,
    padding: `calc(${tokens.spacingHorizontalS} - 1px)`,
  },
  preview: {
    height: '64px',
    display: 'flex',
    overflow: 'hidden',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  previewRail: { width: '16px' },
  previewList: {
    width: '46px',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    padding: '6px 4px',
  },
  previewLine: { height: '6px', borderRadius: '3px' },
  previewChat: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: '5px',
    padding: '8px 6px',
  },
  previewBubble: { height: '10px', width: '60%' },
  help: { color: tokens.colorNeutralForeground3 },
  swatches: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  swatch: {
    width: '28px',
    height: '28px',
    padding: 0,
    borderRadius: '50%',
    cursor: 'pointer',
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  swatchOn: {
    outline: `2px solid ${tokens.colorNeutralForeground1}`,
    outlineOffset: '2px',
  },
  hidden: { position: 'absolute', width: '1px', height: '1px', opacity: 0, pointerEvents: 'none' },
});

function Swatch(p: {
  hex: string;
  label: string;
  testId: string;
  on: boolean;
  onClick: () => void;
}) {
  const styles = useLookStyles();
  return (
    <button
      type="button"
      className={mergeClasses(styles.swatch, p.on && styles.swatchOn)}
      style={{ background: p.hex, color: inkOn(p.hex) }}
      aria-label={p.label}
      aria-pressed={p.on}
      title={p.label}
      onClick={p.onClick}
      data-testid={p.testId}
    >
      {p.on && <Checkmark16Filled />}
    </button>
  );
}

/** Theme (look) and accent colour. The layout stays the same in every look. */
function LookSettings({
  set,
}: {
  set: (change: { look?: Look; accent?: string }) => Promise<void>;
}) {
  const styles = useLookStyles();
  const settings = useApp((s) => s.settings);
  const picker = useRef<HTMLInputElement>(null);
  const settle = useRef<number>(undefined);
  const look = settings?.look ?? 'paper';
  const accent = settings?.accent ?? '';
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const custom = accent && !ACCENTS.includes(accent.toUpperCase()) ? accent : '';
  return (
    <>
      <Field label={strings.settings.look}>
        <div className={styles.looks} role="radiogroup" aria-label={strings.settings.look}>
          {(['classic', 'harbor', 'paper'] as const).map((id) => {
            const t = buildTheme(id, accent, dark);
            return (
              <button
                type="button"
                key={id}
                role="radio"
                aria-checked={look === id}
                className={mergeClasses(styles.look, look === id && styles.lookOn)}
                onClick={() => void set({ look: id })}
                data-testid={`look-${id}`}
              >
                <div className={styles.preview} aria-hidden="true">
                  <div
                    className={styles.previewRail}
                    style={{ background: t.colorNeutralBackground3 }}
                  />
                  <div
                    className={styles.previewList}
                    style={{ background: t.colorNeutralBackground2 }}
                  >
                    {[0, 1, 2].map((i) => (
                      <div
                        key={i}
                        className={styles.previewLine}
                        style={{
                          background: i === 0 ? t.colorBrandBackground2 : t.colorNeutralStroke1,
                        }}
                      />
                    ))}
                  </div>
                  <div
                    className={styles.previewChat}
                    style={{ background: t.colorNeutralBackground1 }}
                  >
                    <div
                      className={styles.previewBubble}
                      style={{
                        background: t.colorNeutralBackground3,
                        borderRadius: t.borderRadiusLarge,
                      }}
                    />
                    <div
                      className={styles.previewBubble}
                      style={{
                        background: t.colorBrandBackground,
                        borderRadius: t.borderRadiusLarge,
                        alignSelf: 'flex-end',
                      }}
                    />
                  </div>
                </div>
                <Text weight="semibold">{strings.settings.looks[id].name}</Text>
                <Text size={200} className={styles.help}>
                  {strings.settings.looks[id].help}
                </Text>
              </button>
            );
          })}
        </div>
      </Field>
      <Field label={strings.settings.accent} hint={strings.settings.accentHelp}>
        <div className={styles.swatches}>
          <Swatch
            hex={lookAccent(look)}
            label={strings.settings.accentDefault}
            testId="accent-default"
            on={!accent}
            onClick={() => void set({ accent: '' })}
          />
          <Divider vertical style={{ flexGrow: 0, height: '24px' }} />
          {ACCENTS.map((hex) => (
            <Swatch
              key={hex}
              hex={hex}
              label={strings.settings.accentSwatch(hex)}
              testId={`accent-${hex.slice(1)}`}
              on={accent.toUpperCase() === hex}
              onClick={() => void set({ accent: hex })}
            />
          ))}
          {custom && (
            <Swatch
              hex={custom}
              label={strings.settings.accentSwatch(custom)}
              testId="accent-custom"
              on
              onClick={() => picker.current?.click()}
            />
          )}
          <Button
            appearance="subtle"
            icon={<Color20Regular />}
            onClick={() => picker.current?.click()}
            data-testid="accent-pick"
          >
            {strings.settings.accentCustom}
          </Button>
          <input
            ref={picker}
            type="color"
            className={styles.hidden}
            tabIndex={-1}
            aria-hidden="true"
            value={accent || lookAccent(look)}
            onChange={(e) => {
              // The picker reports every step of a drag: save once it settles.
              const hex = e.target.value.toUpperCase();
              window.clearTimeout(settle.current);
              settle.current = window.setTimeout(() => void set({ accent: hex }), 250);
            }}
            data-testid="accent-input"
          />
        </div>
      </Field>
    </>
  );
}

function GeneralPane() {
  const styles = useStyles();
  const settings = useApp((s) => s.settings);
  const set = async (change: {
    readReceipts?: boolean;
    startWithWindows?: boolean;
    theme?: 'system' | 'light' | 'dark';
    look?: Look;
    accent?: string;
  }) => useApp.setState({ settings: await core.invoke('settings.set', change) });
  return (
    <>
      <LookSettings set={set} />
      <Field label={strings.settings.appearance} data-testid="setting-theme">
        <RadioGroup
          layout="horizontal"
          value={settings?.theme ?? 'system'}
          onChange={(_e, d) => void set({ theme: d.value as 'system' | 'light' | 'dark' })}
        >
          <Radio value="system" label={strings.settings.themeSystem} data-testid="theme-system" />
          <Radio value="light" label={strings.settings.themeLight} data-testid="theme-light" />
          <Radio value="dark" label={strings.settings.themeDark} data-testid="theme-dark" />
        </RadioGroup>
      </Field>
      <Switch
        label={strings.settings.startWithWindows}
        checked={settings?.startWithWindows ?? true}
        onChange={(_e, d) => void set({ startWithWindows: d.checked })}
      />
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
    </>
  );
}

function FilesPane() {
  const styles = useStyles();
  const settings = useApp((s) => s.settings);
  const [error, setError] = useState<string>();
  const change = async (saveFolder: string) => {
    setError(undefined);
    try {
      useApp.setState({ settings: await core.invoke('settings.set', { saveFolder }) });
    } catch (err) {
      setError(
        err instanceof Error ? err.message.replace(/^.*?: /, '') : strings.files.folderError,
      );
    }
  };
  return (
    <>
      <div>
        <Switch
          label={strings.files.autoReceive}
          checked={settings?.autoReceive ?? true}
          onChange={async (_e, d) =>
            useApp.setState({
              settings: await core.invoke('settings.set', { autoReceive: d.checked }),
            })
          }
          data-testid="setting-auto-receive"
        />
        <Text size={200} block className={styles.help}>
          {strings.files.autoReceiveHelp}
        </Text>
      </div>
      <Field label={strings.files.saveFolder} hint={strings.files.saveFolderHelp}>
        <div className={styles.row}>
          <Input
            readOnly
            value={settings?.saveFolder ?? ''}
            style={{ flex: 1 }}
            aria-label={strings.files.saveFolder}
            data-testid="save-folder"
          />
          <Button
            onClick={async () => {
              const { path } = await core.invoke('files.pickFolder', {});
              if (path) await change(path);
            }}
            data-testid="save-folder-change"
          >
            {strings.files.chooseFolder}
          </Button>
          <Button
            icon={<FolderOpen20Regular />}
            onClick={() => void core.invoke('files.showSaveFolder', {})}
          >
            {strings.files.openFolder}
          </Button>
        </div>
      </Field>
      {error && (
        <Text size={200} data-testid="save-folder-error">
          {error}
        </Text>
      )}
      <Body1 className={styles.help}>{strings.files.neverCopies}</Body1>
    </>
  );
}

function PaneFor({ category }: { category: SettingsCategory }) {
  switch (category) {
    case 'profile':
      return <ProfilePane />;
    case 'general':
      return <GeneralPane />;
    case 'calls':
      return (
        <>
          <DeviceSettings />
          <NoiseSetting />
          <Divider />
          <Hosting />
        </>
      );
    case 'files':
      return <FilesPane />;
    case 'network':
      return <OtherSubnets />;
    case 'backup':
      return <MoveProfile />;
    case 'updates':
      return <Updates />;
    case 'diagnostics':
      return <DiagnosticsSection />;
    case 'about':
      return <About />;
  }
}

export function SettingsDialog({
  onClose,
  initial = 'general',
}: {
  onClose: () => void;
  initial?: SettingsCategory;
}) {
  const styles = useStyles();
  const [category, setCategory] = useState<SettingsCategory>(initial);
  return (
    <Dialog open onOpenChange={(_e, d) => !d.open && onClose()}>
      <DialogSurface className={styles.surface} aria-label={strings.settings.title}>
        <div className={styles.shell}>
          <nav className={styles.nav} aria-label={strings.settings.title}>
            <Text as="h1" size={500} weight="semibold" className={styles.navTitle}>
              {strings.settings.title}
            </Text>
            <TabList
              vertical
              size="large"
              selectedValue={category}
              onTabSelect={(_e, d) => setCategory(d.value as SettingsCategory)}
            >
              {CATEGORIES.map((c) => (
                <Tab key={c.id} value={c.id} icon={c.icon} data-testid={`settings-tab-${c.id}`}>
                  {strings.settings.categories[c.id]}
                </Tab>
              ))}
            </TabList>
          </nav>
          <div className={styles.content}>
            <header className={styles.contentHeader}>
              <Text as="h2" size={600} weight="semibold" data-testid="settings-title">
                {strings.settings.categories[category]}
              </Text>
              <Button
                appearance="subtle"
                icon={<Dismiss20Regular />}
                aria-label={strings.settings.close}
                onClick={onClose}
                data-testid="settings-close"
              />
            </header>
            <div className={styles.pane} data-testid={`settings-pane-${category}`}>
              <PaneFor category={category} />
            </div>
          </div>
        </div>
      </DialogSurface>
    </Dialog>
  );
}
