import { useRef, useState, type JSX } from 'react';
import {
  Avatar,
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
  Textarea,
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
  Info16Regular,
  Info20Regular,
  PaintBrush20Regular,
  Person20Regular,
  PersonCircle20Regular,
  Settings20Regular,
  ShieldCheckmark20Regular,
  Rocket20Regular,
  Mic20Regular,
  Chat20Regular,
  Building20Regular,
} from '@fluentui/react-icons';
import { DeviceSettings, NoiseSetting } from '../calls/DeviceSettings.tsx';
import { isEmail, NOTES_MAX } from '../format.ts';
import { avatarSrc, core, useApp } from '../state.ts';
import { strings } from '../strings.ts';
import { ACCENTS, buildTheme, inkOn, lookAccent, type Look } from '../theme.ts';
import { Logo } from './Logo.tsx';
import {
  About,
  DiagnosticsSection,
  Hosting,
  MoveProfile,
  OtherSubnets,
  Updates,
} from './MoreSettings.tsx';
import { Note, Row, Rows, Section } from './SettingsParts.tsx';

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
    width: 'min(980px, 94vw)',
    maxWidth: '980px',
    height: 'min(700px, 92vh)',
    padding: 0,
    overflow: 'hidden',
  },
  shell: { display: 'flex', height: '100%', minHeight: 0 },
  nav: {
    width: '244px',
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalL,
    padding: `${tokens.spacingVerticalXL} ${tokens.spacingHorizontalM}`,
    background: tokens.colorNeutralBackground1,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  navHead: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalM,
    padding: `0 ${tokens.spacingHorizontalS}`,
  },
  // Rounded rows, the one in use filled with the accent's pale colour.
  tabs: {
    '& [role="tab"]': {
      borderRadius: tokens.borderRadiusLarge,
      paddingLeft: tokens.spacingHorizontalM,
    },
    '& [role="tab"]:hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
    '& [role="tab"][aria-selected="true"]': {
      backgroundColor: tokens.colorBrandBackground2,
      color: tokens.colorBrandForeground2,
    },
    '& [role="tab"][aria-selected="true"] svg': { color: tokens.colorBrandForeground1 },
  },
  navFoot: { marginTop: 'auto', padding: `0 ${tokens.spacingHorizontalS}` },
  help: { color: tokens.colorNeutralForeground3 },
  content: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' },
  contentHeader: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalL,
    padding: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalXL}`,
    background: tokens.colorNeutralBackground1,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  headerChip: {
    flexShrink: 0,
    width: '40px',
    height: '40px',
    display: 'grid',
    placeItems: 'center',
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
  },
  headerText: {
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    minWidth: 0,
    '& > h2': { margin: 0 },
  },
  // The page: a pale ground with the cards raised on it.
  pane: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalXL} 0`,
    background: tokens.colorNeutralBackground2,
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalL,
    '::after': { content: '""', flexShrink: 0, height: tokens.spacingVerticalXXL },
  },
  row: { display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalM },
  grow: { flexGrow: 1, minWidth: 0 },
  words: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS },
  word: {
    padding: `2px ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground3,
  },
  mono: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200 },
  // Save stays in view while the page scrolls.
  saveBar: {
    position: 'sticky',
    bottom: 0,
    zIndex: 1,
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalM,
    margin: `0 calc(-1 * ${tokens.spacingHorizontalXL})`,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalXL}`,
    background: tokens.colorNeutralBackground1,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow8,
  },
  narrowInput: { maxWidth: '240px' },
});

/** Avatars are kept at this size so a colleague can view the picture enlarged without it blurring. */
const AVATAR_SIDE = 256;

/**
 * Square-crop and shrink a picture to 256x256 on this PC (avatars are capped at 128 KB). WebP keeps
 * a photo to a few KB; the type comes from what the browser actually produced.
 */
async function avatarBytes(
  file: File,
): Promise<{ data: Uint8Array<ArrayBuffer>; mime: 'image/png' | 'image/webp' }> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = new OffscreenCanvas(AVATAR_SIDE, AVATAR_SIDE);
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
      AVATAR_SIDE,
      AVATAR_SIDE,
    );
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.86 });
  return {
    data: new Uint8Array(await blob.arrayBuffer()),
    mime: blob.type === 'image/webp' ? 'image/webp' : 'image/png',
  };
}

function ProfilePane() {
  const styles = useStyles();
  const identity = useApp((s) => s.identity)!;
  const fileInput = useRef<HTMLInputElement>(null);
  const [displayName, setDisplayName] = useState(identity.displayName);
  const [jobTitle, setJobTitle] = useState(identity.jobTitle ?? '');
  const [statusMessage, setStatusMessage] = useState(identity.statusMessage ?? '');
  const [joinedOn, setJoinedOn] = useState(identity.joinedOn ?? '');
  const [workplace, setWorkplace] = useState<'office' | 'home' | 'none'>(
    identity.workplace ?? 'none',
  );
  const [email, setEmail] = useState(identity.email ?? '');
  const [notes, setNotes] = useState(identity.notes ?? '');
  const [clearAfter, setClearAfter] = useState<'never' | 'hour' | 'today' | 'week'>('never');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();
  const emailBad = email.trim() !== '' && !isEmail(email);
  const dirty =
    displayName !== identity.displayName ||
    jobTitle !== (identity.jobTitle ?? '') ||
    joinedOn !== (identity.joinedOn ?? '') ||
    statusMessage !== (identity.statusMessage ?? '') ||
    workplace !== (identity.workplace ?? 'none') ||
    email.trim() !== (identity.email ?? '') ||
    notes.trim() !== (identity.notes ?? '');

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
        joinedOn,
        statusMessage,
        email: email.trim(),
        workplace: workplace === 'none' ? '' : workplace,
        notes,
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

  const edit = (set: (v: string) => void) => (_e: unknown, d: { value: string }) => {
    set(d.value);
    setSaved(false);
  };

  return (
    <>
      <Section
        icon={<PersonCircle20Regular />}
        title={strings.settings.sections.photo}
        description={strings.settings.sections.photoHelp}
      >
        <Rows>
          <Row title={strings.settings.avatar}>
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
                const { data, mime } = await avatarBytes(file);
                useApp.setState({
                  identity: await core.invoke('profile.setAvatar', { data, mime }),
                });
              }}
            />
          </Row>
          <Row stacked>
            <Field label={strings.me.displayName} required>
              <Input
                value={displayName}
                maxLength={64}
                onChange={edit(setDisplayName)}
                data-testid="profile-name-input"
              />
            </Field>
          </Row>
        </Rows>
      </Section>

      <Section
        icon={<Building20Regular />}
        title={strings.settings.sections.aboutYou}
        description={strings.settings.sections.aboutYouHelp}
      >
        <Rows>
          <Row stacked>
            <Field label={strings.me.jobTitle}>
              <Input value={jobTitle} maxLength={64} onChange={edit(setJobTitle)} />
            </Field>
          </Row>
          <Row stacked>
            <Field label={strings.me.joinedOn} hint={strings.me.joinedOnHelp}>
              <Input
                type="date"
                value={joinedOn}
                min="1950-01-01"
                max="2100-12-31"
                className={styles.narrowInput}
                onChange={edit(setJoinedOn)}
                data-testid="profile-joined-input"
              />
            </Field>
          </Row>
          <Row stacked>
            <Field label={strings.me.statusMessage}>
              <Input
                value={statusMessage}
                maxLength={280}
                placeholder={strings.me.statusPlaceholder}
                onChange={edit(setStatusMessage)}
                data-testid="profile-status-input"
              />
            </Field>
          </Row>
          <Row title={strings.settings.clearAfter}>
            <Select
              value={clearAfter}
              aria-label={strings.settings.clearAfter}
              onChange={(_e, d) => setClearAfter(d.value as typeof clearAfter)}
            >
              {(['never', 'hour', 'today', 'week'] as const).map((k) => (
                <option key={k} value={k}>
                  {strings.settings.clearOptions[k]}
                </option>
              ))}
            </Select>
          </Row>
          <Row title={strings.workplace.question} description={strings.workplace.help}>
            <RadioGroup
              layout="horizontal"
              value={workplace}
              aria-label={strings.workplace.question}
              onChange={(_e, d) => {
                setWorkplace(d.value as typeof workplace);
                setSaved(false);
              }}
              data-testid="profile-workplace"
            >
              <Radio
                value="office"
                label={strings.workplace.option.office}
                data-testid="profile-workplace-office"
              />
              <Radio
                value="home"
                label={strings.workplace.option.home}
                data-testid="profile-workplace-home"
              />
              <Radio value="none" label={strings.workplace.option.none} />
            </RadioGroup>
          </Row>
        </Rows>
      </Section>

      <Section
        icon={<Chat20Regular />}
        title={strings.settings.sections.contact}
        description={strings.settings.sections.contactHelp}
      >
        <Rows>
          <Row stacked>
            <Field
              label={strings.me.email}
              validationState={emailBad ? 'error' : 'none'}
              validationMessage={emailBad ? strings.me.emailInvalid : undefined}
            >
              <Input
                type="email"
                value={email}
                maxLength={120}
                placeholder={strings.me.emailPlaceholder}
                onChange={edit(setEmail)}
                data-testid="profile-email-input"
              />
            </Field>
          </Row>
          <Row stacked>
            <Field
              label={strings.me.notes}
              hint={`${strings.me.notesHelp} ${strings.me.notesCount(notes.length, NOTES_MAX)}`}
            >
              <Textarea
                value={notes}
                rows={4}
                resize="vertical"
                maxLength={NOTES_MAX}
                placeholder={strings.me.notesPlaceholder}
                onChange={edit(setNotes)}
                data-testid="profile-notes-input"
              />
            </Field>
          </Row>
        </Rows>
      </Section>

      <Section
        icon={<ShieldCheckmark20Regular />}
        title={strings.settings.identity}
        description={strings.settings.identityHelp}
      >
        <Rows>
          <Row stacked>
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
          </Row>
        </Rows>
      </Section>

      <div className={styles.saveBar}>
        <Button
          appearance="primary"
          disabled={!displayName.trim() || emailBad || saving || !dirty}
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
        {dirty && !saved && (
          <Text size={200} className={styles.help}>
            {strings.settings.unsaved}
          </Text>
        )}
        {error && <Text size={200}>{error}</Text>}
      </div>
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
      <Row stacked>
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
      </Row>
      <Row stacked>
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
      </Row>
    </>
  );
}

function GeneralPane() {
  const settings = useApp((s) => s.settings);
  const set = async (change: {
    startWithWindows?: boolean;
    theme?: 'system' | 'light' | 'dark';
    look?: Look;
    accent?: string;
  }) => useApp.setState({ settings: await core.invoke('settings.set', change) });
  return (
    <>
      <Section
        icon={<PaintBrush20Regular />}
        title={strings.settings.sections.appearance}
        description={strings.settings.sections.appearanceHelp}
      >
        <Rows>
          <LookSettings set={set} />
          <Row title={strings.settings.appearance} testId="setting-theme">
            <RadioGroup
              layout="horizontal"
              value={settings?.theme ?? 'system'}
              aria-label={strings.settings.appearance}
              onChange={(_e, d) => void set({ theme: d.value as 'system' | 'light' | 'dark' })}
            >
              <Radio
                value="system"
                label={strings.settings.themeSystem}
                data-testid="theme-system"
              />
              <Radio value="light" label={strings.settings.themeLight} data-testid="theme-light" />
              <Radio value="dark" label={strings.settings.themeDark} data-testid="theme-dark" />
            </RadioGroup>
          </Row>
        </Rows>
      </Section>
      <Section
        icon={<Rocket20Regular />}
        title={strings.settings.sections.startup}
        description={strings.settings.sections.startupHelp}
      >
        <Rows>
          <Row title={strings.settings.startWithWindows}>
            <Switch
              checked={settings?.startWithWindows ?? true}
              aria-label={strings.settings.startWithWindows}
              onChange={(_e, d) => void set({ startWithWindows: d.checked })}
            />
          </Row>
        </Rows>
      </Section>
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
      <Section
        icon={<ArrowDownload20Regular />}
        title={strings.settings.sections.receiving}
        description={strings.settings.sections.receivingHelp}
      >
        <Rows>
          <Row title={strings.files.autoReceive} description={strings.files.autoReceiveHelp}>
            <Switch
              checked={settings?.autoReceive ?? true}
              aria-label={strings.files.autoReceive}
              onChange={async (_e, d) =>
                useApp.setState({
                  settings: await core.invoke('settings.set', { autoReceive: d.checked }),
                })
              }
              data-testid="setting-auto-receive"
            />
          </Row>
        </Rows>
      </Section>
      <Section
        icon={<Folder20Regular />}
        title={strings.settings.sections.location}
        description={strings.settings.sections.locationHelp}
      >
        <Rows>
          <Row title={strings.files.saveFolder} description={strings.files.saveFolderHelp} stacked>
            <div className={styles.row}>
              <Input
                readOnly
                value={settings?.saveFolder ?? ''}
                className={styles.grow}
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
            {error && (
              <Text size={200} data-testid="save-folder-error">
                {error}
              </Text>
            )}
          </Row>
        </Rows>
      </Section>
      <Note icon={<Info16Regular />}>{strings.files.neverCopies}</Note>
    </>
  );
}

function CallsPane() {
  return (
    <>
      <Section
        icon={<Mic20Regular />}
        title={strings.settings.sections.devices}
        description={strings.settings.sections.devicesHelp}
      >
        <DeviceSettings />
      </Section>
      <Section
        icon={<Call20Regular />}
        title={strings.calls.noise.label}
        description={strings.calls.noise.help}
      >
        <NoiseSetting />
      </Section>
      <Hosting />
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
      return <CallsPane />;
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
  const version = useApp((s) => s.info?.appVersion);
  const current = CATEGORIES.find((c) => c.id === category)!;
  return (
    <Dialog open onOpenChange={(_e, d) => !d.open && onClose()}>
      <DialogSurface className={styles.surface} aria-label={strings.settings.title}>
        <div className={styles.shell}>
          <nav className={styles.nav} aria-label={strings.settings.title}>
            <div className={styles.navHead}>
              <Logo size={28} />
              <Text as="h1" size={500} weight="semibold">
                {strings.settings.title}
              </Text>
            </div>
            <TabList
              vertical
              size="large"
              className={styles.tabs}
              selectedValue={category}
              onTabSelect={(_e, d) => setCategory(d.value as SettingsCategory)}
            >
              {CATEGORIES.map((c) => (
                <Tab key={c.id} value={c.id} icon={c.icon} data-testid={`settings-tab-${c.id}`}>
                  {strings.settings.categories[c.id]}
                </Tab>
              ))}
            </TabList>
            {version && (
              <Text size={200} className={mergeClasses(styles.help, styles.navFoot)}>
                InterCom {version}
              </Text>
            )}
          </nav>
          <div className={styles.content}>
            <header className={styles.contentHeader}>
              <span className={styles.headerChip} aria-hidden="true">
                {current.icon}
              </span>
              <span className={styles.headerText}>
                <Text as="h2" size={600} weight="semibold" data-testid="settings-title">
                  {strings.settings.categories[category]}
                </Text>
                <Text size={200} className={styles.help}>
                  {strings.settings.categoryHelp[category]}
                </Text>
              </span>
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
