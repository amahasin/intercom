import { useEffect, useRef, useState } from 'react';
import {
  Button,
  Dropdown,
  Field,
  makeStyles,
  Option,
  ProgressBar,
  Radio,
  RadioGroup,
  Text,
  tokens,
} from '@fluentui/react-components';
import { core, useApp } from '../state.ts';
import { strings } from '../strings.ts';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM },
  preview: {
    width: '240px',
    aspectRatio: '16 / 9',
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground3,
    objectFit: 'cover',
    transform: 'scaleX(-1)',
  },
  help: { color: tokens.colorNeutralForeground3 },
});

/** How much background sound is removed from what this PC sends. */
export function NoiseSetting() {
  const settings = useApp((st) => st.settings);
  return (
    <Field label={strings.calls.noise.label} hint={strings.calls.noise.help}>
      <RadioGroup
        value={settings?.noiseSuppression ?? 'high'}
        onChange={async (_e, d) =>
          useApp.setState({
            settings: await core.invoke('settings.set', {
              noiseSuppression: d.value as 'off' | 'standard' | 'high',
            }),
          })
        }
      >
        <Radio value="high" label={strings.calls.noise.high} data-testid="noise-high" />
        <Radio value="standard" label={strings.calls.noise.standard} data-testid="noise-standard" />
        <Radio value="off" label={strings.calls.noise.off} data-testid="noise-off" />
      </RadioGroup>
    </Field>
  );
}

type Key = 'audioInput' | 'audioOutput' | 'videoInput';

/** Microphone, speaker and camera choice, a live preview and level, and a test call. */
export function DeviceSettings() {
  const s = useStyles();
  const settings = useApp((st) => st.settings);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [level, setLevel] = useState(0);
  const [test, setTest] = useState<'idle' | 'recording' | 'playing'>('idle');
  const video = useRef<HTMLVideoElement>(null);

  // Open the chosen camera and microphone while the settings are on screen.
  useEffect(() => {
    let stream: MediaStream | undefined;
    let raf = 0;
    let ctx: AudioContext | undefined;
    let cancelled = false;
    const id = (v: string | undefined) => (v ? { deviceId: { exact: v } } : {});
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: id(settings?.audioInput),
          video: { width: 640, height: 360, ...id(settings?.videoInput) },
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => undefined);
      }
      if (cancelled || !stream) {
        stream?.getTracks().forEach((t) => t.stop());
        return;
      }
      setDevices(await navigator.mediaDevices.enumerateDevices());
      if (video.current) video.current.srcObject = stream;
      ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      const loop = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const v of data) sum += ((v - 128) / 128) ** 2;
        setLevel(Math.min(1, Math.sqrt(sum / data.length) * 4));
        raf = requestAnimationFrame(loop);
      };
      loop();
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close();
    };
  }, [settings?.audioInput, settings?.videoInput]);

  const choose = async (key: Key, value: string) =>
    useApp.setState({ settings: await core.invoke('settings.set', { [key]: value }) });

  const picker = (key: Key, kind: MediaDeviceKind, label: string) => {
    const list = devices.filter(
      (d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications',
    );
    const current = settings?.[key] ?? '';
    const name = list.find((d) => d.deviceId === current)?.label || strings.calls.systemDefault;
    return (
      <Field label={label}>
        <Dropdown
          value={name}
          selectedOptions={[current]}
          onOptionSelect={(_e, d) => void choose(key, d.optionValue ?? '')}
          data-testid={`device-${key}`}
        >
          <Option value="">{strings.calls.systemDefault}</Option>
          {list.map((d) => (
            <Option key={d.deviceId} value={d.deviceId}>
              {d.label || d.deviceId.slice(0, 8)}
            </Option>
          ))}
        </Dropdown>
      </Field>
    );
  };

  /** Record five seconds and play them back through the chosen speaker (an echo test). */
  const testCall = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: settings?.audioInput ? { deviceId: { exact: settings.audioInput } } : true,
    });
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => chunks.push(e.data);
    setTest('recording');
    recorder.start();
    await new Promise((r) => window.setTimeout(r, 5_000));
    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      recorder.stop();
    });
    stream.getTracks().forEach((t) => t.stop());
    const audio = new Audio(URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType })));
    const sink = audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (settings?.audioOutput && sink.setSinkId)
      await sink.setSinkId(settings.audioOutput).catch(() => {});
    setTest('playing');
    audio.onended = () => setTest('idle');
    await audio.play().catch(() => setTest('idle'));
  };

  return (
    <div className={s.root} data-testid="device-settings">
      <Text weight="semibold">{strings.calls.devices}</Text>
      {picker('audioInput', 'audioinput', strings.calls.microphone)}
      <ProgressBar value={level} thickness="large" aria-label={strings.calls.microphone} />
      {picker('audioOutput', 'audiooutput', strings.calls.speaker)}
      {picker('videoInput', 'videoinput', strings.calls.camera)}
      <video ref={video} className={s.preview} autoPlay playsInline muted />
      <div>
        <Button
          disabled={test !== 'idle'}
          onClick={() => void testCall()}
          data-testid="device-test-call"
        >
          {test === 'recording'
            ? strings.calls.recording
            : test === 'playing'
              ? strings.calls.playing
              : strings.calls.testCall}
        </Button>
        <Text size={200} block className={s.help}>
          {strings.calls.testCallHelp}
        </Text>
      </div>
    </div>
  );
}
