/**
 * Settings added in M6: colleagues on other subnets, hosting large meetings, moving the
 * profile to another PC, updates from a shared folder, and diagnostics.
 */
import { useEffect, useState } from 'react';
import {
  Button,
  Divider,
  Field,
  Input,
  makeStyles,
  Radio,
  RadioGroup,
  Text,
  tokens,
} from '@fluentui/react-components';
import type { Diagnostics, UpdateStatus } from '@officemesh/protocol/ipc';
import { core, useApp } from '../state.ts';
import { strings } from '../strings.ts';

const useStyles = makeStyles({
  section: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalS },
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

function errorText(err: unknown): string {
  return err instanceof Error ? err.message.replace(/^.*?: /, '') : String(err);
}

function OtherSubnets() {
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

function Hosting() {
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

function MoveProfile() {
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

function Updates() {
  const s = useStyles();
  const settings = useApp((st) => st.settings);
  const [folder, setFolder] = useState(settings?.updateFolder ?? '');
  const [status, setStatus] = useState<UpdateStatus>();
  useEffect(() => {
    void core.invoke('updates.status', {}).then(setStatus);
    return core.on('updates.changed', setStatus);
  }, []);
  return (
    <div className={s.section}>
      <Text weight="semibold">{t().updatesTitle}</Text>
      <Text size={200} className={s.help}>
        {t().updatesHelp}
      </Text>
      <div className={s.row}>
        <Input
          value={folder}
          placeholder="\\fileserver\apps\officemesh"
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
      {status && (
        <Text size={200} data-testid="update-status">
          {t().updateState(status)}
        </Text>
      )}
    </div>
  );
}

function DiagnosticsSection() {
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

function About() {
  const s = useStyles();
  const [version, setVersion] = useState('');
  useEffect(() => {
    void core.invoke('app.info', {}).then((i) => setVersion(i.appVersion));
  }, []);
  return (
    <div className={s.section} data-testid="about">
      <Text weight="semibold">{t().aboutTitle(version)}</Text>
      {t().limits.map((l) => (
        <Text key={l} size={200} className={s.help}>
          {l}
        </Text>
      ))}
    </div>
  );
}

export function MoreSettings() {
  return (
    <>
      <Divider />
      <OtherSubnets />
      <Divider />
      <Hosting />
      <Divider />
      <MoveProfile />
      <Divider />
      <Updates />
      <Divider />
      <DiagnosticsSection />
      <Divider />
      <About />
    </>
  );
}

/** "Version x is ready", or "a colleague runs a newer version" (plan section 15). */
export function UpdateBanner() {
  const network = useApp((st) => st.network);
  const [status, setStatus] = useState<UpdateStatus>();
  useEffect(() => {
    void core.invoke('updates.status', {}).then(setStatus);
    return core.on('updates.changed', setStatus);
  }, []);
  if (status?.state === 'available' && status.version) {
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
        <Text>{t().updateReady(status.version, status.signature === 'unsigned')}</Text>
        <Button size="small" onClick={() => void core.invoke('updates.install', {})}>
          {t().install}
        </Button>
      </div>
    );
  }
  if (network?.newerVersion) {
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
