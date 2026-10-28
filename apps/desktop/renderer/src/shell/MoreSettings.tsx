/**
 * Settings added in M6: colleagues on other subnets, hosting large meetings, moving the
 * profile to another PC, updates from a shared folder, and diagnostics.
 */
import { useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  Link,
  makeStyles,
  ProgressBar,
  Radio,
  RadioGroup,
  Spinner,
  Switch,
  Text,
  tokens,
} from '@fluentui/react-components';
import { ArrowSync20Regular, Open20Regular } from '@fluentui/react-icons';
import type { Diagnostics, UpdateStatus } from '@officemesh/protocol/ipc';
import { useCall } from '../calls/engine.ts';
import { core, useApp } from '../state.ts';
import { strings } from '../strings.ts';
import { Logo } from './Logo.tsx';
import { useExpired } from './ephemeral.ts';
import { openWhatsNew } from './WhatsNew.tsx';

const useStyles = makeStyles({
  section: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalS },
  // The Updates page: the installed version first, then the two ways of looking for a newer one.
  page: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM },
  hero: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalL,
    padding: tokens.spacingHorizontalL,
    borderRadius: tokens.borderRadiusXLarge,
    background: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  heroText: { display: 'flex', flexDirection: 'column', flex: '1 1 160px', minWidth: 0 },
  heroActions: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    rowGap: tokens.spacingVerticalS,
  },
  statusLine: { color: tokens.colorNeutralForeground2, padding: `0 ${tokens.spacingHorizontalS}` },
  card: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  row: { display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalS },
  help: { color: tokens.colorNeutralForeground3 },
  pre: {
    maxHeight: '240px',
    overflow: 'auto',
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase100,
    background: tokens.colorNeutralBackground3,
    padding: tokens.spacingHorizontalS,
    whiteSpace: 'pre-wrap',
  },
});

const t = () => strings.more;

/** An update that has been offered is started by itself after this long. */
const UPDATE_COUNTDOWN_S = 120;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message.replace(/^.*?: /, '') : String(err);
}

export function OtherSubnets() {
  const s = useStyles();
  const settings = useApp((st) => st.settings);
  const [address, setAddress] = useState('');
  const [note, setNote] = useState('');
  const add = async () => {
    setNote(t().adding);
    try {
      const r = await core.invoke('network.addPeer', { address });
      useApp.setState({ settings: await core.invoke('settings.get', {}) });
      setNote(r.userId ? t().added(r.name ?? t().aColleague) : t().notReached);
      setAddress('');
    } catch (err) {
      setNote(errorText(err));
    }
  };
  const remove = async (a: string) =>
    useApp.setState({
      settings: await core.invoke('settings.set', {
        peerAddresses: (settings?.peerAddresses ?? []).filter((x) => x !== a),
      }),
    });
  return (
    <div className={s.section}>
      <Text weight="semibold">{t().subnetsTitle}</Text>
      <Text size={200} className={s.help}>
        {t().subnetsHelp}
      </Text>
      <div className={s.row}>
        <Input
          value={address}
          placeholder="10.1.2.3"
          onChange={(_e, d) => setAddress(d.value)}
          data-testid="peer-address"
        />
        <Button disabled={!address.trim()} onClick={() => void add()} data-testid="peer-add">
          {t().add}
        </Button>
      </div>
      {note && (
        <Text size={200} data-testid="peer-add-note">
          {note}
        </Text>
      )}
      {(settings?.peerAddresses ?? []).map((a) => (
        <div key={a} className={s.row}>
          <Text>{a}</Text>
          <Button size="small" appearance="subtle" onClick={() => void remove(a)}>
            {t().remove}
          </Button>
        </div>
      ))}
    </div>
  );
}

export function Hosting() {
  const s = useStyles();
  const settings = useApp((st) => st.settings);
  const [relay, setRelay] = useState<Diagnostics['relay']>();
  useEffect(() => {
    void core.invoke('diagnostics.get', {}).then((d) => setRelay(d.relay));
  }, [settings?.relayHosting]);
  return (
    <div className={s.section}>
      <Text weight="semibold">{t().hostingTitle}</Text>
      <RadioGroup
        value={settings?.relayHosting ?? 'auto'}
        onChange={(_e, d) =>
          void core
            .invoke('settings.set', { relayHosting: d.value as 'auto' | 'never' })
            .then((v) => useApp.setState({ settings: v }))
        }
      >
        <Radio value="auto" label={t().hostingAuto} />
        <Radio value="never" label={t().hostingNever} />
      </RadioGroup>
      {relay && (
        <Text size={200} className={s.help} data-testid="relay-capability">
          {relay.capable ? t().capable : ''} {relay.reason}
        </Text>
      )}
    </div>
  );
}

export function MoveProfile() {
  const s = useStyles();
  const [passphrase, setPassphrase] = useState('');
  const [importPath, setImportPath] = useState<string | null>(null);
  const [importPass, setImportPass] = useState('');
  const [note, setNote] = useState('');
  const [ready, setReady] = useState(false);
  return (
    <div className={s.section}>
      <Text weight="semibold">{t().moveTitle}</Text>
      <Text size={200} className={s.help}>
        {t().moveHelp}
      </Text>
      <Field label={t().passphrase} hint={t().passphraseHint}>
        <Input
          type="password"
          value={passphrase}
          onChange={(_e, d) => setPassphrase(d.value)}
          data-testid="export-passphrase"
        />
      </Field>
      <div className={s.row}>
        <Button
          disabled={passphrase.length < 8}
          data-testid="export-profile"
          onClick={async () => {
            setNote(t().exporting);
            try {
              const { path } = await core.invoke('profile.export', { passphrase });
              setNote(t().exported(path));
              setPassphrase('');
            } catch (err) {
              setNote(errorText(err));
            }
          }}
        >
          {t().export}
        </Button>
        <Button
          data-testid="import-profile"
          onClick={async () => setImportPath((await core.invoke('profile.pickImport', {})).path)}
        >
          {t().import}
        </Button>
      </div>
      {importPath && !ready && (
        <div className={s.row}>
          <Input
            type="password"
            placeholder={t().passphrase}
            value={importPass}
            onChange={(_e, d) => setImportPass(d.value)}
          />
          <Button
            appearance="primary"
            onClick={async () => {
              try {
                const who = await core.invoke('profile.import', {
                  path: importPath,
                  passphrase: importPass,
                });
                setReady(true);
                setNote(t().imported(who.displayName));
              } catch (err) {
                setNote(errorText(err));
              }
            }}
          >
            {t().check}
          </Button>
        </div>
      )}
      {note && (
        <Text size={200} data-testid="profile-note">
          {note}
        </Text>
      )}
      {ready && (
        <Button appearance="primary" onClick={() => void core.invoke('app.restart', {})}>
          {t().restart}
        </Button>
      )}
    </div>
  );
}

/** The version this PC runs, how it stands against what is published, and where to look. */
export function Updates() {
  const s = useStyles();
  const settings = useApp((st) => st.settings);
  const info = useApp((st) => st.info);
  const [folder, setFolder] = useState(settings?.updateFolder ?? '');
  const [status, setStatus] = useState<UpdateStatus>();
  useEffect(() => {
    void core.invoke('updates.status', {}).then(setStatus);
    return core.on('updates.changed', setStatus);
  }, []);
  const on = settings?.githubUpdates ?? true;
  const autoInstall = settings?.autoInstallUpdates ?? true;
  // Installing by itself needs the installer on this PC, so it makes the download automatic too.
  const autoDownload = (settings?.autoDownloadUpdates ?? true) || autoInstall;
  const checking = status?.state === 'checking';
  const checkedAt = status?.checkedAt
    ? new Date(status.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : undefined;
  const badge =
    status === undefined
      ? undefined
      : status.state === 'off'
        ? { text: t().badgeOff, color: 'informative' as const }
        : status.state === 'checking'
          ? { text: t().badgeChecking, color: 'informative' as const }
          : status.state === 'none'
            ? { text: t().badgeCurrent, color: 'success' as const }
            : status.state === 'downloading'
              ? { text: t().badgeDownloading(status.version ?? ''), color: 'brand' as const }
              : status.state === 'available'
                ? {
                    text: status.downloaded
                      ? t().badgeReady(status.version ?? '')
                      : t().badgeAvailable(status.version ?? ''),
                    color: 'brand' as const,
                  }
                : { text: t().badgeFailed, color: 'danger' as const };
  return (
    <div className={s.page} data-testid="updates-page">
      <div className={s.hero}>
        <Logo size={48} />
        <div className={s.heroText}>
          <Text size={200} className={s.help}>
            {t().installed}
          </Text>
          <Text size={700} weight="semibold" data-testid="installed-version">
            {info?.appVersion ?? ''}
          </Text>
          <Text size={200} className={s.help}>
            {[
              info?.machine?.arch === 'arm64'
                ? 'ARM64'
                : info?.machine?.arch === 'x64'
                  ? '64-bit'
                  : '',
              checkedAt ? t().lastChecked(checkedAt) : t().neverChecked,
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </div>
        <div className={s.heroActions}>
          {badge && (
            <Badge
              appearance="tint"
              shape="rounded"
              size="large"
              color={badge.color}
              icon={checking ? <Spinner size="extra-tiny" /> : undefined}
              data-testid="update-badge"
            >
              {badge.text}
            </Badge>
          )}
          <div className={s.row}>
            <Button
              icon={<ArrowSync20Regular />}
              disabled={!on || checking}
              onClick={async () => setStatus(await core.invoke('updates.check', { manual: true }))}
              data-testid="check-for-updates"
            >
              {t().checkForUpdates}
            </Button>
            {status?.state === 'available' && status.source === 'github' && (
              <Button
                appearance="primary"
                onClick={() => void core.invoke('updates.install', {}).catch(() => {})}
                data-testid="update-install"
              >
                {t().install}
              </Button>
            )}
          </div>
        </div>
      </div>
      {status?.state === 'downloading' && status.progress !== undefined && (
        <ProgressBar value={status.progress} max={100} />
      )}
      {status && (
        <Text size={200} className={s.statusLine} data-testid="update-status">
          {t().updateState(status)}
        </Text>
      )}

      <div className={s.card}>
        <Switch
          checked={on}
          label={t().githubUpdates}
          onChange={async (_e, d) => {
            useApp.setState({
              settings: await core.invoke('settings.set', { githubUpdates: d.checked }),
            });
            setStatus(await core.invoke('updates.check', { manual: d.checked }));
          }}
          data-testid="github-updates"
        />
        <Text size={200} className={s.help}>
          {t().githubUpdatesHelp}
        </Text>
        <Switch
          checked={autoInstall}
          disabled={!on}
          label={t().autoInstall}
          onChange={async (_e, d) => {
            useApp.setState({
              settings: await core.invoke('settings.set', { autoInstallUpdates: d.checked }),
            });
          }}
          data-testid="auto-install-updates"
        />
        <Text size={200} className={s.help}>
          {t().autoInstallHelp}
        </Text>
        <Switch
          checked={autoDownload}
          disabled={!on || autoInstall}
          label={t().autoDownload}
          onChange={async (_e, d) => {
            useApp.setState({
              settings: await core.invoke('settings.set', { autoDownloadUpdates: d.checked }),
            });
          }}
          data-testid="auto-download-updates"
        />
        <Text size={200} className={s.help}>
          {t().autoDownloadHelp}
        </Text>
      </div>

      <div className={s.card}>
        <Text weight="semibold">{t().folderLabel}</Text>
        <Text size={200} className={s.help}>
          {t().folderHelp}
        </Text>
        <div className={s.row}>
          <Input
            value={folder}
            placeholder="\\fileserver\apps\intercom"
            onChange={(_e, d) => setFolder(d.value)}
            style={{ flex: 1 }}
            data-testid="update-folder"
          />
          <Button
            onClick={async () => {
              useApp.setState({
                settings: await core.invoke('settings.set', { updateFolder: folder }),
              });
              setStatus(await core.invoke('updates.check', {}));
            }}
          >
            {t().checkNow}
          </Button>
        </div>
      </div>
    </div>
  );
}
export function DiagnosticsSection() {
  const s = useStyles();
  const [diag, setDiag] = useState<Diagnostics>();
  const [note, setNote] = useState('');
  return (
    <div className={s.section}>
      <Text weight="semibold">{t().diagnosticsTitle}</Text>
      <div className={s.row}>
        <Button
          data-testid="diagnostics-show"
          onClick={async () => setDiag(await core.invoke('diagnostics.get', {}))}
        >
          {t().showDiagnostics}
        </Button>
        <Button
          data-testid="diagnostics-export"
          onClick={async () => {
            const { path } = await core.invoke('diagnostics.export', {});
            setNote(t().exported(path));
          }}
        >
          {t().exportDiagnostics}
        </Button>
      </div>
      {note && <Text size={200}>{note}</Text>}
      {diag && (
        <div className={s.pre} data-testid="diagnostics">
          {t().diagnosticsSummary(diag)}
          {'\n\n'}
          {diag.log.slice(-40).join('\n')}
        </div>
      )}
    </div>
  );
}

export function About() {
  const s = useStyles();
  const [version, setVersion] = useState('');
  const [repository, setRepository] = useState('');
  useEffect(() => {
    void core.invoke('app.info', {}).then((i) => {
      setVersion(i.appVersion);
      setRepository(i.repository ?? '');
    });
  }, []);
  // The address is built here from the repository name the app was built with; main opens it in
  // the default browser (the renderer itself never loads anything from the internet).
  const url = repository ? `https://github.com/${repository}` : '';
  return (
    <div className={s.section} data-testid="about">
      <Text weight="semibold">{t().aboutTitle(version)}</Text>
      <div>
        <Button size="small" onClick={openWhatsNew} data-testid="about-whats-new">
          {strings.whatsNew.open}
        </Button>
      </div>
      {url && (
        <div className={s.row}>
          <Text size={200}>{t().repository}</Text>
          <Link
            href={url}
            target="_blank"
            rel="noreferrer"
            data-testid="about-repository"
            title={t().openInBrowser}
          >
            {url.replace('https://', '')} <Open20Regular style={{ verticalAlign: 'text-bottom' }} />
          </Link>
        </div>
      )}
      {t().limits.map((l) => (
        <Text key={l} size={200} className={s.help}>
          {l}
        </Text>
      ))}
    </div>
  );
}

/** How long "Later" puts the reminder off: it comes back after this (a waiting update is not forgotten). */
const REMIND_AFTER_MS = 4 * 60 * 60_000;

/**
 * "Later" on the update banner: hidden for a few hours, then shown again (and shown at once for a
 * newer version than the one put off). Kept for the session only: a restart asks again.
 */
let putOff: { version: string; until: number } | undefined;
function useUpdateReminder(version: string | undefined): [boolean, (version: string) => void] {
  // "Now", as far as this hook needs it: moved on when "Later" is pressed and when the wait is over.
  const [now, setNow] = useState(() => Date.now());
  const until = putOff?.until;
  useEffect(() => {
    if (until === undefined || until <= now) return;
    const timer = window.setTimeout(() => setNow(Date.now()), until - now + 50);
    return () => window.clearTimeout(timer);
  }, [until, now]);
  const hidden = putOff !== undefined && putOff.version === version && putOff.until > now;
  return [
    hidden,
    (v) => {
      const at = Date.now();
      putOff = { version: v, until: at + REMIND_AFTER_MS };
      setNow(at);
    },
  ];
}

/** "Version x is ready", or "a colleague runs a newer version" (plan section 15). */
export function UpdateBanner() {
  const network = useApp((st) => st.network);
  const [status, setStatus] = useState<UpdateStatus>();
  useEffect(() => {
    void core.invoke('updates.status', {}).then(setStatus);
    return core.on('updates.changed', setStatus);
  }, []);
  const [later, snooze] = useUpdateReminder(status?.version);
  // "A colleague runs a newer version" only informs: it goes after a few seconds.
  const newerGone = useExpired(network?.newerVersion ? `newer:${network.newerVersion}` : undefined);
  if (
    (status?.state === 'available' || status?.state === 'downloading') &&
    status.version &&
    !later
  ) {
    const downloading = status.state === 'downloading';
    return (
      <div
        role="status"
        data-testid="update-banner"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacingHorizontalM,
          padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalL}`,
          background: tokens.colorBrandBackground2,
        }}
      >
        <Text>
          {downloading
            ? t().updateDownloading(status.version, status.progress)
            : status.downloaded
              ? status.auto
                ? t().updateAuto(status.version)
                : t().updateDownloaded(status.version)
              : t().updateReady(status.version, status.source)}
          {status.error ? ` ${status.error}` : ''}
        </Text>
        <Button
          size="small"
          appearance="primary"
          disabled={downloading}
          onClick={() => void core.invoke('updates.install', {}).catch(() => {})}
          data-testid="update-banner-install"
        >
          {t().install}
        </Button>
        {/* An update the office requires cannot wait; any other one is put off and asked again. */}
        {!status.required && !downloading && (
          <Button
            size="small"
            appearance="subtle"
            onClick={() => snooze(status.version!)}
            data-testid="update-banner-later"
          >
            {t().updateLater}
          </Button>
        )}
      </div>
    );
  }
  if (network?.newerVersion && !newerGone) {
    return (
      <div
        role="status"
        data-testid="newer-version-banner"
        style={{
          padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalL}`,
          background: tokens.colorNeutralBackground3,
        }}
      >
        <Text size={200}>{t().colleagueNewer(network.newerVersion)}</Text>
      </div>
    );
  }
  return null;
}

/**
 * A newer InterCom in the office's update folder has to be installed: nothing else in the main
 * window can be used until it is (the window cannot be dismissed, only the installer started, and
 * left alone it starts by itself). A call in progress is never cut off: the notice waits, as the
 * banner, until it is over.
 */
export function RequiredUpdate() {
  const [status, setStatus] = useState<UpdateStatus>();
  const inCall = useCall((st) => st.call !== null);
  const autoInstall = useApp((st) => st.settings?.autoInstallUpdates ?? true);
  useEffect(() => {
    void core.invoke('updates.status', {}).then(setStatus);
    return core.on('updates.changed', setStatus);
  }, []);
  const waiting = status?.state === 'available' || status?.state === 'downloading';
  // Only an update that is required stops the app (the office's folder, or a release that asks).
  if (!waiting || !status.required || !status.version || inCall) return null;
  // A release from GitHub is installed by itself, at a moment that does not break into anything
  // (see `Settings.autoInstallUpdates`), not by a countdown that does not look at what is open.
  if (status.source === 'github' && autoInstall) return null;
  return (
    <RequiredUpdateDialog
      version={status.version}
      unsigned={status.signature === 'unsigned'}
      downloading={status.state === 'downloading'}
      progress={status.progress}
    />
  );
}

function RequiredUpdateDialog({
  version,
  unsigned,
  downloading,
  progress,
}: {
  version: string;
  unsigned: boolean;
  downloading: boolean;
  progress: number | undefined;
}) {
  const [current, setCurrent] = useState('');
  const [starting, setStarting] = useState(false);
  // An install that did not work is not started again by itself (the button tries once more).
  const [failed, setFailed] = useState(false);
  const [left, setLeft] = useState(UPDATE_COUNTDOWN_S);
  const [shownAt] = useState(() => Date.now());
  const install = () => {
    setStarting(true);
    setFailed(false);
    void core.invoke('updates.install', {}).catch(() => {
      setStarting(false);
      setFailed(true);
    });
  };
  useEffect(() => {
    void core.invoke('app.info', {}).then((i) => setCurrent(i.appVersion));
  }, []);
  // Not answered, it goes ahead by itself: the update is not optional.
  useEffect(() => {
    if (starting || failed || downloading) return;
    const t = window.setInterval(() => {
      const rest = UPDATE_COUNTDOWN_S - Math.floor((Date.now() - shownAt) / 1_000);
      setLeft(rest);
      if (rest <= 0) {
        window.clearInterval(t);
        install();
      }
    }, 1_000);
    return () => window.clearInterval(t);
  }, [starting, failed, downloading, shownAt]);
  return (
    <Dialog open modalType="alert">
      <DialogSurface data-testid="update-required">
        <DialogBody>
          <DialogTitle>{t().updateRequiredTitle}</DialogTitle>
          <DialogContent>
            <Text block>{t().updateRequiredBody(version, current)}</Text>
            {downloading && (
              <Text block size={200} data-testid="update-downloading">
                {t().updateDownloading(version, progress)}
              </Text>
            )}
            {!starting && !failed && !downloading && (
              <Text block size={200} data-testid="update-countdown">
                {t().updateCountdown(Math.max(0, left))}
              </Text>
            )}
            {unsigned && (
              <Text block size={200} style={{ marginTop: tokens.spacingVerticalS }}>
                {t().updateUnsigned}
              </Text>
            )}
          </DialogContent>
          <DialogActions>
            <Button
              appearance="primary"
              disabled={starting || downloading}
              data-testid="update-required-install"
              onClick={install}
            >
              {starting || downloading ? t().updateStarting : t().install}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
