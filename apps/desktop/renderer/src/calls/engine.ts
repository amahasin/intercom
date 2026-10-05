/**
 * The call's media: one RTCPeerConnection per other participant (full mesh, plan section
 * 9), with "perfect negotiation" so simultaneous renegotiations (camera toggles, screen
 * share) resolve instead of deadlocking. Signaling goes through the core, which signs SDP
 * and relays it over the peer link. Lives outside React so media survives view changes.
 */
import { create } from 'zustand';
import type { CallSignal, CallView, IpcEventPayload, ScreenSource } from '@officemesh/protocol/ipc';
import type { CALL_REACTIONS, MsgRef } from '@officemesh/protocol';
import { core, useApp } from '../state.ts';
import { BlurPipeline } from './blur.ts';
import { Recorder, type RecordingSources } from './recorder.ts';
import {
  attachWhiteboard,
  detachWhiteboard,
  resetWhiteboard,
  whiteboardJson,
} from './whiteboard.ts';

/** No heartbeat for this long: the participant is gone (cable pulled, PC off). */
const DROP_AFTER_MS = 6_000;
/** A connection that never comes up is given up after this long. */
const CONNECT_TIMEOUT_MS = 20_000;
const HEARTBEAT_MS = 1_000;
/** Above this many people, video steps down to 360p per tile (plan section 9). */
const LOW_RES_ABOVE = 4;
/** Above this many people, only the 4 most recent speakers send video. */
const SPEAKERS_ONLY_ABOVE = 6;
const VIDEO_SPEAKERS = 4;
const SPEAKING_LEVEL = 0.04;

export interface RemoteMedia {
  userId: string;
  camera: MediaStream | undefined;
  screen: MediaStream | undefined;
  state: RTCPeerConnectionState;
  speaking: boolean;
}

interface CallUi {
  call: CallView | null;
  view: 'full' | 'mini';
  local: MediaStream | undefined;
  localScreen: MediaStream | undefined;
  muted: boolean;
  camera: boolean;
  onHold: boolean;
  sharing: boolean;
  speaking: boolean;
  remotes: Record<string, RemoteMedia>;
  /** Why the last outgoing call ended without anyone joining, shown for a few seconds. */
  notice: IpcEventPayload<'call.ended'> | undefined;
  error: string | undefined;
  /** A short message for this user (muted by the organiser, blur turned off…). */
  message: string | undefined;
  blur: boolean;
  /** What this user's own tile shows: the blurred camera while blur is on. */
  preview: MediaStream | undefined;
  recording: boolean;
  /** Live reactions on screen (each shown for a few seconds). */
  reactions: Array<{ id: number; from: string; emoji: (typeof CALL_REACTIONS)[number] }>;
  layout: 'gallery' | 'speaker';
  chatOpen: boolean;
}

export const useCall = create<CallUi>(() => ({
  call: null,
  view: 'full',
  local: undefined,
  localScreen: undefined,
  muted: false,
  camera: false,
  onHold: false,
  sharing: false,
  speaking: false,
  remotes: {},
  notice: undefined,
  error: undefined,
  message: undefined,
  blur: false,
  preview: undefined,
  recording: false,
  reactions: [],
  layout: 'gallery',
  chatOpen: false,
}));

class PeerLink {
  readonly pc: RTCPeerConnection;
  readonly userId: string;
  readonly polite: boolean;
  readonly heartbeat: RTCDataChannel;
  readonly whiteboard: RTCDataChannel;
  makingOffer = false;
  ignoreOffer = false;
  rollbacks = 0;
  createdAt = Date.now();
  connectedAt: number | undefined;
  lastHeard = 0;
  /** The first video m-line carries the camera; any later one carries a screen share. */
  /** The camera's transceiver: the connector's first video one, or the first in the offer. */
  cameraTransceiver: RTCRtpTransceiver | undefined;
  screenSender: RTCRtpSender | undefined;
  audioEl: HTMLAudioElement;
  analyser: AnalyserNode | undefined;
  camera = new MediaStream();
  screen = new MediaStream();

  constructor(userId: string, polite: boolean) {
    this.userId = userId;
    this.polite = polite;
    this.pc = new RTCPeerConnection({ iceServers: [] });
    // Negotiated on both sides with the same id, so neither waits for the other to open it.
    this.heartbeat = this.pc.createDataChannel('heartbeat', { negotiated: true, id: 0 });
    this.whiteboard = this.pc.createDataChannel('whiteboard', { negotiated: true, id: 1 });
    this.audioEl = document.createElement('audio');
    this.audioEl.autoplay = true;
    this.audioEl.dataset['peer'] = userId;
    document.body.append(this.audioEl);
  }

  close(): void {
    this.heartbeat.close();
    this.whiteboard.close();
    this.pc.close();
    this.audioEl.srcObject = null;
    this.audioEl.remove();
  }
}

let callId: string | undefined;
let selfId = '';
const links = new Map<string, PeerLink>();
let audioContext: AudioContext | undefined;
let localAnalyser: AnalyserNode | undefined;
let ticker: number | undefined;
let speakingSince = 0;
let acceptedAt: number | undefined;
let shareStartedAt = 0;

const set = (patch: Partial<CallUi>) => useCall.setState(patch);

/**
 * Call changes and signals are handled strictly one after another: a candidate must not
 * be applied while its offer is still being set, and media must be open before answering.
 */
let queue: Promise<void> = Promise.resolve();
function serial(task: () => Promise<void>): Promise<void> {
  const run = queue.then(task).catch((err: unknown) => console.warn('call task failed', err));
  queue = run;
  return run;
}
const others = (call: CallView) => call.participants.filter((p) => p.userId !== selfId);

function setRemote(userId: string, patch: Partial<RemoteMedia>): void {
  useCall.setState((s) => {
    const prev = s.remotes[userId] ?? {
      userId,
      camera: undefined,
      screen: undefined,
      state: 'new' as RTCPeerConnectionState,
      speaking: false,
    };
    return { remotes: { ...s.remotes, [userId]: { ...prev, ...patch } } };
  });
}

function send(to: string, signal: CallSignal): void {
  if (!callId) return;
  void core.invoke('calls.signal', { callId, to, signal }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Local media
// ---------------------------------------------------------------------------

function deviceConstraint(id: string | undefined): { deviceId?: { exact: string } } {
  return id ? { deviceId: { exact: id } } : {};
}

/**
 * Test builds started with `--fake-media` draw a moving test pattern instead of opening a
 * camera: Chromium's synthetic capture device stops for good, now and then, when several
 * app instances use it at once, which would make call tests fail at random.
 */
const syntheticCamera = new URLSearchParams(location.search).has('synthetic-camera');

function testPatternTrack(): MediaStreamTrack {
  const canvas = document.createElement('canvas');
  // 720p, so blur is measured at the resolution the plan names (M5).
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d')!;
  const track = canvas.captureStream(30).getVideoTracks()[0]!;
  let frame = 0;
  const timer = window.setInterval(() => {
    if (track.readyState === 'ended') {
      window.clearInterval(timer);
      return;
    }
    frame++;
    ctx.fillStyle = `hsl(${(frame * 2) % 360} 60% 35%)`;
    ctx.fillRect(0, 0, 1280, 720);
    ctx.fillStyle = '#fff';
    ctx.fillRect((frame * 12) % 1280, 300, 120, 120);
    ctx.font = '48px sans-serif';
    ctx.fillText(`${useApp.getState().identity?.displayName ?? ''} ${frame}`, 40, 80);
  }, 33);
  return track;
}

/**
 * getUserMedia, retried briefly: a camera just released (turned off a moment ago, or by
 * another app) can report itself missing or busy while Windows' capture service restarts.
 */
async function getMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
  if (syntheticCamera && constraints.video) {
    const stream = constraints.audio
      ? await getMedia({ audio: constraints.audio })
      : new MediaStream();
    stream.addTrack(testPatternTrack());
    return stream;
  }
  for (let attempt = 0; ; attempt++) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      const transient =
        name === 'NotFoundError' || name === 'NotReadableError' || name === 'AbortError';
      if (!transient || attempt >= 3) throw err;
      await new Promise((r) => window.setTimeout(r, 300 * (attempt + 1)));
    }
  }
}

async function openLocal(video: boolean): Promise<MediaStream> {
  const settings = useApp.getState().settings;
  const audio = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    ...deviceConstraint(settings?.audioInput),
  };
  const cam = {
    width: 1280,
    height: 720,
    frameRate: 30,
    ...deviceConstraint(settings?.videoInput),
  };
  try {
    return await getMedia({ audio, video: video ? cam : false });
  } catch {
    // A chosen device that went away: fall back to the defaults.
    return getMedia({
      audio: true,
      video: video ? { width: 1280, height: 720 } : false,
    });
  }
}

function watchLocalLevel(stream: MediaStream): void {
  audioContext ??= new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  localAnalyser = audioContext.createAnalyser();
  localAnalyser.fftSize = 512;
  source.connect(localAnalyser);
}

function level(analyser: AnalyserNode | undefined): number {
  if (!analyser) return 0;
  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (const v of data) sum += ((v - 128) / 128) ** 2;
  return Math.sqrt(sum / data.length);
}

function micTrack(): MediaStreamTrack | null {
  return useCall.getState().local?.getAudioTracks()[0] ?? null;
}

/** The camera as it is sent: blurred while blur is on. */
function cameraTrack(): MediaStreamTrack | null {
  if (blurPipe) return blurPipe.output;
  return rawCamera();
}

function rawCamera(): MediaStreamTrack | null {
  return useCall.getState().local?.getVideoTracks()[0] ?? null;
}

// ---------------------------------------------------------------------------
// Background blur
// ---------------------------------------------------------------------------

let blurPipe: BlurPipeline | undefined;
let blurInput: MediaStreamTrack | undefined;

/** Put the current camera (blurred or not) on every connection. */
async function sendCamera(): Promise<void> {
  const call = useCall.getState().call;
  if (!call) return;
  const wanted = useCall.getState().camera && videoSenders(call).has(selfId) ? cameraTrack() : null;
  for (const link of links.values()) {
    const t = link.cameraTransceiver;
    if (t && t.sender.track !== wanted) await t.sender.replaceTrack(wanted);
  }
}

/** Keep the blur pipeline in step with the camera: start, restart on a new camera, stop. */
async function refreshBlur(): Promise<void> {
  const state = useCall.getState();
  const raw = rawCamera();
  const want = state.blur && state.camera && raw && raw.readyState === 'live';
  if (!want) {
    blurPipe?.stop();
    blurPipe = undefined;
    blurInput = undefined;
    set({ preview: state.local });
    await sendCamera();
    return;
  }
  if (blurPipe && blurInput === raw) return;
  blurPipe?.stop();
  blurInput = raw;
  try {
    blurPipe = await BlurPipeline.start(raw, () => {
      // Too slow on this PC: switch it off and say so (plan M5).
      void serial(async () => {
        set({ blur: false, message: 'Background blur turned off: this PC cannot keep up.' });
        await refreshBlur();
      });
    });
    set({ preview: new MediaStream([blurPipe.output]) });
  } catch (err) {
    blurPipe = undefined;
    blurInput = undefined;
    set({
      blur: false,
      preview: useCall.getState().local,
      message: `Background blur is not available: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  await sendCamera();
}

export function setBlur(on: boolean): Promise<void> {
  set({ blur: on, message: undefined });
  return serial(refreshBlur);
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

let recorder: Recorder | undefined;

function recordingSources(): RecordingSources {
  const s = useCall.getState();
  const call = s.call;
  const tiles = (call?.participants ?? []).map((p) => ({
    name: p.userId === selfId ? `${p.name} (you)` : p.name,
    video:
      p.userId === selfId
        ? s.camera
          ? s.preview
          : undefined
        : p.video
          ? s.remotes[p.userId]?.camera
          : undefined,
  }));
  const screen =
    s.localScreen ?? Object.values(s.remotes).find((r) => r.screen !== undefined)?.screen;
  const audio = [
    ...(s.local ? [s.local] : []),
    ...[...links.values()].flatMap((l) =>
      l.audioEl.srcObject ? [l.audioEl.srcObject as MediaStream] : [],
    ),
  ];
  return { tiles, screen, audio };
}

/** Record the meeting locally; everyone sees the banner while it runs (plan section 9). */
export async function startRecording(): Promise<void> {
  const call = useCall.getState().call;
  if (!call || recorder) return;
  try {
    const title = call.convId ? (useApp.getState().conversations[call.convId]?.title ?? '') : '';
    recorder = await Recorder.start(title, recordingSources);
    set({ recording: true });
    update({ recording: true });
  } catch (err) {
    set({ error: err instanceof Error ? err.message : String(err) });
  }
}

/** Stop and share the file to the meeting chat (or the 1:1 chat with the caller). */
export async function stopRecording(): Promise<void> {
  const rec = recorder;
  const call = useCall.getState().call;
  if (!rec) return;
  recorder = undefined;
  set({ recording: false });
  update({ recording: false });
  const convId =
    call?.convId ??
    Object.values(useApp.getState().conversations).find(
      (c) => c.kind === 'direct' && call?.participants.some((p) => p.userId === c.peerUserId),
    )?.convId;
  try {
    if (convId) await rec.stop(convId);
    else await rec.abort();
  } catch (err) {
    set({ error: err instanceof Error ? err.message : String(err) });
  }
}

// ---------------------------------------------------------------------------
// Peer connections
// ---------------------------------------------------------------------------

function linkFor(userId: string): PeerLink {
  const existing = links.get(userId);
  if (existing) return existing;
  // Lower userId is the polite peer: it yields when both offer at once.
  const link = new PeerLink(userId, selfId < userId);
  links.set(userId, link);
  const { pc } = link;
  setRemote(userId, { state: 'new' });

  pc.onnegotiationneeded = async () => {
    try {
      link.makingOffer = true;
      await pc.setLocalDescription();
      const d = pc.localDescription;
      if (d && (d.type === 'offer' || d.type === 'answer'))
        send(userId, { kind: 'sdp', type: d.type, sdp: d.sdp });
    } catch (err) {
      console.warn('negotiation failed', err);
    } finally {
      link.makingOffer = false;
    }
  };
  pc.onicecandidate = ({ candidate }) => {
    send(userId, {
      kind: 'ice',
      candidate: candidate
        ? {
            candidate: candidate.candidate,
            sdpMid: candidate.sdpMid,
            sdpMLineIndex: candidate.sdpMLineIndex,
            usernameFragment: candidate.usernameFragment,
          }
        : null,
    });
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected' && link.connectedAt === undefined) {
      link.connectedAt = Date.now();
      link.lastHeard = Date.now();
    }
    setRemote(userId, { state: pc.connectionState });
  };
  pc.ontrack = ({ track, transceiver }) => {
    if (track.kind === 'audio') {
      const stream = new MediaStream([track]);
      link.audioEl.srcObject = stream;
      applySink(link.audioEl);
      link.audioEl.muted = useCall.getState().onHold;
      audioContext ??= new AudioContext();
      link.analyser = audioContext.createAnalyser();
      link.analyser.fftSize = 512;
      audioContext.createMediaStreamSource(stream).connect(link.analyser);
      return;
    }
    link.cameraTransceiver ??= transceiver;
    if (link.cameraTransceiver === transceiver) {
      link.camera = new MediaStream([track]);
      setRemote(userId, { camera: link.camera });
    } else {
      link.screen = new MediaStream([track]);
      setRemote(userId, { screen: link.screen });
      track.onmute = () => setRemote(userId, { screen: undefined });
      track.onunmute = () => setRemote(userId, { screen: link.screen });
    }
  };
  link.heartbeat.onmessage = () => {
    link.lastHeard = Date.now();
  };
  attachWhiteboard(userId, link.whiteboard);
  return link;
}

/** The connecting side sets up the transceivers: audio, then camera video. */
function startLink(userId: string): void {
  const link = linkFor(userId);
  const { pc } = link;
  if (pc.getTransceivers().length > 0) return;
  const call = useCall.getState().call;
  pc.addTransceiver(micTrack() ?? 'audio', { direction: 'sendrecv' });
  if (call?.media === 'video') {
    // Always sendrecv: the camera turns on and off by swapping the track, not renegotiating.
    const cam = useCall.getState().camera ? cameraTrack() : null;
    link.cameraTransceiver = pc.addTransceiver(cam ?? 'video', { direction: 'sendrecv' });
  }
  if (useCall.getState().sharing) attachScreen(link);
}

/** After an offer from the other side: put our tracks on the transceivers it created. */
async function fillAnswer(link: PeerLink): Promise<void> {
  const call = useCall.getState().call;
  let seenVideo = false;
  for (const t of link.pc.getTransceivers()) {
    if (t.sender.track || t.currentDirection === 'stopped') continue;
    const kind = t.receiver.track.kind;
    if (kind === 'audio' && !t.sender.track) {
      await t.sender.replaceTrack(micTrack());
      t.direction = 'sendrecv';
    } else if (kind === 'video' && !seenVideo) {
      seenVideo = true;
      link.cameraTransceiver ??= t;
      if (t !== link.cameraTransceiver) continue;
      const cam = call?.media === 'video' && useCall.getState().camera ? cameraTrack() : null;
      await t.sender.replaceTrack(cam);
      t.direction = 'sendrecv';
    }
  }
}

async function onSignal({
  callId: id,
  from,
  signal,
}: IpcEventPayload<'call.signal'>): Promise<void> {
  if (id !== callId) return;
  const link = linkFor(from);
  const { pc } = link;
  try {
    if (signal.kind === 'sdp') {
      const offerCollision =
        signal.type === 'offer' && (link.makingOffer || pc.signalingState !== 'stable');
      link.ignoreOffer = !link.polite && offerCollision;
      if (link.ignoreOffer) return;
      if (offerCollision) link.rollbacks++;
      await pc.setRemoteDescription({ type: signal.type, sdp: signal.sdp });
      if (signal.type === 'offer') {
        await fillAnswer(link);
        await pc.setLocalDescription();
        const d = pc.localDescription;
        if (d) send(from, { kind: 'sdp', type: 'answer', sdp: d.sdp });
      }
    } else if (signal.candidate) {
      try {
        await pc.addIceCandidate(signal.candidate);
      } catch (err) {
        if (!link.ignoreOffer) throw err;
      }
    }
  } catch (err) {
    console.warn('signal failed', err);
  }
}

function dropLink(userId: string): void {
  detachWhiteboard(userId);
  links.get(userId)?.close();
  links.delete(userId);
  useCall.setState((s) => {
    const remotes = { ...s.remotes };
    delete remotes[userId];
    return { remotes };
  });
}

// ---------------------------------------------------------------------------
// Roster-driven behaviour
// ---------------------------------------------------------------------------

/** Who may send video: everyone, or above 6 people only the 4 most recent speakers. */
export function videoSenders(call: CallView): Set<string> {
  const people = call.participants;
  if (people.length <= SPEAKERS_ONLY_ABOVE) return new Set(people.map((p) => p.userId));
  const ranked = [...people].sort(
    (a, b) => b.lastSpokeAt - a.lastSpokeAt || a.joinedAt - b.joinedAt,
  );
  return new Set(ranked.slice(0, VIDEO_SPEAKERS).map((p) => p.userId));
}

async function applyVideoPolicy(call: CallView): Promise<void> {
  const sendVideo = videoSenders(call).has(selfId) && useCall.getState().camera;
  const lowRes = call.participants.length > LOW_RES_ABOVE;
  for (const link of links.values()) {
    const t = link.cameraTransceiver;
    if (!t) continue;
    const wanted = sendVideo ? cameraTrack() : null;
    if (t.sender.track !== wanted) await t.sender.replaceTrack(wanted);
    const params = t.sender.getParameters();
    if (params.encodings?.[0]) {
      params.encodings[0].scaleResolutionDownBy = lowRes ? 2 : 1;
      params.encodings[0].maxBitrate = lowRes ? 600_000 : 1_800_000;
      await t.sender.setParameters(params).catch(() => {});
    }
  }
}

async function onCallChanged({ call }: IpcEventPayload<'call.changed'>): Promise<void> {
  const prev = useCall.getState().call;
  if (!call) {
    teardown();
    return;
  }
  if (call.callId !== callId) resetWhiteboard();
  callId = call.callId;
  selfId = useApp.getState().identity?.userId ?? selfId;
  set({ call, ...(prev?.callId !== call.callId && { view: 'full' }) });
  if (call.state === 'ringing') return;
  if (!useCall.getState().local) await beginMedia(call);
  // One sharer at a time: a newer share (already confirmed by its sharer) replaces ours.
  // Two shares started within 2 s of each other count as simultaneous: higher userId keeps it.
  if (useCall.getState().sharing) {
    const newer = call.participants.filter(
      (p) =>
        p.userId !== selfId &&
        p.sharing &&
        !prev?.participants.find((q) => q.userId === p.userId)?.sharing,
    );
    const simultaneous = Date.now() - shareStartedAt < 2_000;
    if (newer.some((p) => !simultaneous || p.userId > selfId)) await stopShare();
  }
  const present = new Set(others(call).map((p) => p.userId));
  for (const userId of links.keys()) if (!present.has(userId)) dropLink(userId);
  const me = call.participants.find((p) => p.userId === selfId);
  for (const p of others(call)) {
    if (links.has(p.userId)) continue;
    // The later joiner connects; the other side answers when the offer arrives.
    if (me && (p.joinedAt < me.joinedAt || (p.joinedAt === me.joinedAt && p.userId < selfId))) {
      startLink(p.userId);
    }
  }
  void applyVideoPolicy(call);
}

async function beginMedia(call: CallView): Promise<void> {
  const me = call.participants.find((p) => p.userId === selfId);
  const wantVideo = call.media === 'video' && (me?.video ?? true);
  try {
    const stream = await openLocal(wantVideo);
    set({
      local: stream,
      preview: stream,
      camera: wantVideo && stream.getVideoTracks().length > 0,
      error: undefined,
    });
    watchLocalLevel(stream);
    for (const t of stream.getTracks()) watchTrack(t);
  } catch (err) {
    // Join without devices for now; the device check opens them as soon as it can.
    set({
      local: new MediaStream(),
      camera: wantVideo,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  ticker ??= window.setInterval(tick, HEARTBEAT_MS / 2);
}

/**
 * A camera or microphone can stop by itself (unplugged, driver reset, taken by another app)
 * or fail to open. While the camera is meant to be on (or the microphone is in use) and
 * its track is missing or ended, reopen it every few seconds and put the new track on
 * every connection. `stop()` never fires `ended`, so tracks we stop are not "lost".
 */
function watchTrack(track: MediaStreamTrack): void {
  track.onended = () => {
    lastDeviceAttempt = 0;
  };
}

let recovering = false;
let lastDeviceAttempt = 0;
const DEVICE_RETRY_MS = 3_000;

function checkDevices(now: number): void {
  const s = useCall.getState();
  if (recovering || now - lastDeviceAttempt < DEVICE_RETRY_MS) return;
  if (!s.call || s.call.state === 'ringing' || !s.local) return;
  const mic = s.local.getAudioTracks()[0];
  const cam = s.local.getVideoTracks()[0];
  const kind: 'audio' | 'video' | null =
    !mic || mic.readyState === 'ended'
      ? 'audio'
      : s.camera && (!cam || cam.readyState === 'ended')
        ? 'video'
        : null;
  if (!kind) return;
  recovering = true;
  lastDeviceAttempt = now;
  void serial(() => reopenDevice(kind)).finally(() => {
    recovering = false;
  });
}

async function reopenDevice(kind: 'audio' | 'video', force = false): Promise<void> {
  const call = useCall.getState().call;
  if (!call) return;
  if (kind === 'video' && force && !useCall.getState().camera) return;
  const settings = useApp.getState().settings;
  let fresh: MediaStreamTrack | undefined;
  try {
    const stream = await getMedia(
      kind === 'audio'
        ? {
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
              ...deviceConstraint(settings?.audioInput),
            },
          }
        : {
            video: {
              width: 1280,
              height: 720,
              frameRate: 30,
              ...deviceConstraint(settings?.videoInput),
            },
          },
    );
    fresh = stream.getTracks()[0];
  } catch (err) {
    set({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  const state = useCall.getState();
  if (!fresh || !state.local || (kind === 'video' && !state.camera)) {
    fresh?.stop();
    return;
  }
  for (const t of kind === 'audio' ? state.local.getAudioTracks() : state.local.getVideoTracks()) {
    state.local.removeTrack(t);
    t.stop();
  }
  if (kind === 'audio') fresh.enabled = !state.muted && !state.onHold;
  state.local.addTrack(fresh);
  watchTrack(fresh);
  const next = new MediaStream(state.local.getTracks());
  set({ local: next, error: undefined });
  if (kind === 'audio') watchLocalLevel(next);
  for (const link of links.values()) {
    const t =
      kind === 'audio'
        ? link.pc.getTransceivers().find((x) => x.receiver.track.kind === 'audio')
        : link.cameraTransceiver;
    if (!t) continue;
    if (kind === 'video' && !videoSenders(call).has(selfId)) continue;
    await t.sender.replaceTrack(fresh);
  }
  if (kind === 'video') {
    set({ preview: next });
    await refreshBlur();
  }
  if (kind === 'video' && !call.participants.find((p) => p.userId === selfId)?.video) {
    update({ video: true });
  }
}

function tick(): void {
  const now = Date.now();
  const state = useCall.getState();
  checkDevices(now);
  // Heartbeats, and dropping participants who went silent.
  for (const link of [...links.values()]) {
    if (link.heartbeat.readyState === 'open') link.heartbeat.send('.');
    const silent = link.connectedAt !== undefined && now - link.lastHeard > DROP_AFTER_MS;
    const neverUp = link.connectedAt === undefined && now - link.createdAt > CONNECT_TIMEOUT_MS;
    if ((silent || neverUp || link.pc.connectionState === 'failed') && callId) {
      void core.invoke('calls.dropped', { callId, userId: link.userId }).catch(() => {});
      dropLink(link.userId);
      continue;
    }
    const speaking = level(link.analyser) > SPEAKING_LEVEL;
    if (state.remotes[link.userId]?.speaking !== speaking) setRemote(link.userId, { speaking });
  }
  // Our own speaking: gossiped to the roster (drives active speaker and video senders).
  const speaking = !state.muted && !state.onHold && level(localAnalyser) > SPEAKING_LEVEL;
  if (speaking !== state.speaking) set({ speaking });
  if (speaking) {
    if (!speakingSince) speakingSince = now;
    if (now - speakingSince > 300 && callId) {
      void core.invoke('calls.update', { callId, spoke: true }).catch(() => {});
      speakingSince = now + 2_000;
    }
  } else speakingSince = 0;
}

function teardown(): void {
  if (recorder) void stopRecording();
  blurPipe?.stop();
  blurPipe = undefined;
  blurInput = undefined;
  for (const userId of [...links.keys()]) dropLink(userId);
  const { local, localScreen } = useCall.getState();
  for (const t of [...(local?.getTracks() ?? []), ...(localScreen?.getTracks() ?? [])]) t.stop();
  if (localScreen) void core.invoke('screen.border', { sourceId: null }).catch(() => {});
  if (ticker) window.clearInterval(ticker);
  ticker = undefined;
  localAnalyser = undefined;
  callId = undefined;
  acceptedAt = undefined;
  set({
    call: null,
    local: undefined,
    localScreen: undefined,
    muted: false,
    camera: false,
    onHold: false,
    sharing: false,
    speaking: false,
    remotes: {},
    preview: undefined,
    recording: false,
    reactions: [],
    chatOpen: false,
  });
}

function applySink(el: HTMLAudioElement): void {
  const sink = useApp.getState().settings?.audioOutput;
  const media = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
  if (sink && media.setSinkId) void media.setSinkId(sink).catch(() => {});
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function update(change: {
  muted?: boolean;
  video?: boolean;
  sharing?: boolean;
  onHold?: boolean;
  hand?: boolean;
  recording?: boolean;
}): void {
  if (callId) void core.invoke('calls.update', { callId, ...change }).catch(() => {});
}

export async function startCall(userIds: string[], media: 'audio' | 'video', convId?: string) {
  try {
    const call = await core.invoke('calls.start', { userIds, media, ...(convId && { convId }) });
    set({ notice: undefined });
    await serial(() => onCallChanged({ call }));
  } catch (err) {
    set({ message: err instanceof Error ? err.message : String(err) });
  }
}

export async function acceptCall(video: boolean): Promise<void> {
  const call = useCall.getState().call;
  if (!call) return;
  acceptedAt = Date.now();
  const accepted = await core.invoke('calls.accept', { callId: call.callId, video });
  await serial(() => onCallChanged({ call: accepted }));
}

/** Meet now in a chat or channel (or join the meeting already running there). */
export async function meetNow(
  convId: string,
  media: 'audio' | 'video',
  meeting?: MsgRef,
): Promise<void> {
  try {
    acceptedAt = Date.now();
    const call = await core.invoke('calls.meetNow', { convId, media, ...(meeting && { meeting }) });
    await serial(() => onCallChanged({ call }));
  } catch (err) {
    set({ message: err instanceof Error ? err.message : String(err) });
  }
}

/** Join the meeting a "call started" card announces. */
export async function joinMeeting(convId: string, target: MsgRef): Promise<void> {
  try {
    acceptedAt = Date.now();
    const call = await core.invoke('calls.join', { convId, target });
    await serial(() => onCallChanged({ call }));
  } catch (err) {
    set({ message: err instanceof Error ? err.message : String(err) });
  }
}

let reactionSeq = 0;
function showReaction(from: string, emoji: (typeof CALL_REACTIONS)[number]): void {
  const id = ++reactionSeq;
  useCall.setState((s) => ({ reactions: [...s.reactions, { id, from, emoji }] }));
  window.setTimeout(
    () => useCall.setState((s) => ({ reactions: s.reactions.filter((r) => r.id !== id) })),
    3_000,
  );
}

export function react(emoji: (typeof CALL_REACTIONS)[number]): void {
  if (callId) void core.invoke('calls.react', { callId, emoji }).catch(() => {});
}

export function toggleHand(): void {
  const call = useCall.getState().call;
  const me = call?.participants.find((p) => p.userId === selfId);
  update({ hand: !me?.hand });
}

/** Organiser controls: mute one person or everyone, remove someone, spotlight (null clears). */
export function control(action: 'mute' | 'remove' | 'spotlight', target: string | null): void {
  if (!callId) return;
  void core
    .invoke('calls.control', { callId, action, target })
    .catch((err: unknown) => set({ error: err instanceof Error ? err.message : String(err) }));
}

export function setLayout(layout: 'gallery' | 'speaker'): void {
  set({ layout });
}

export function setChatOpen(chatOpen: boolean): void {
  set({ chatOpen });
}

/** Switch microphone, camera or speaker during a call (plan section 9). */
export async function switchDevice(
  kind: 'audioInput' | 'videoInput' | 'audioOutput',
  deviceId: string,
): Promise<void> {
  useApp.setState({ settings: await core.invoke('settings.set', { [kind]: deviceId }) });
  if (kind === 'audioOutput') {
    for (const link of links.values()) applySink(link.audioEl);
    return;
  }
  await serial(async () => {
    await reopenDevice(kind === 'audioInput' ? 'audio' : 'video', true);
  });
}

export function declineCall(): void {
  const call = useCall.getState().call;
  if (call) void core.invoke('calls.decline', { callId: call.callId });
}

export function hangUp(): void {
  const call = useCall.getState().call;
  if (call) void core.invoke('calls.hangup', { callId: call.callId });
  teardown();
}

export function toggleMute(): void {
  const muted = !useCall.getState().muted;
  const mic = micTrack();
  if (mic) mic.enabled = !muted && !useCall.getState().onHold;
  set({ muted });
  update({ muted });
}

/**
 * Camera on or off by swapping the camera sender's track: no renegotiation, so toggles on
 * both sides at once cannot collide. Others show the avatar from the roster's `video` flag.
 */
export async function toggleCamera(): Promise<void> {
  const call = useCall.getState().call;
  if (!call || call.media !== 'video') return;
  const on = !useCall.getState().camera;
  let track: MediaStreamTrack | null = null;
  if (on) {
    const settings = useApp.getState().settings;
    try {
      const cam = await getMedia({
        video: {
          width: 1280,
          height: 720,
          frameRate: 30,
          ...deviceConstraint(settings?.videoInput),
        },
      });
      track = cam.getVideoTracks()[0] ?? null;
    } catch (err) {
      // Keep the camera "on": the device check opens it as soon as it can.
      set({ error: err instanceof Error ? err.message : String(err), camera: true });
      lastDeviceAttempt = Date.now();
      return;
    }
  }
  const local = useCall.getState().local ?? new MediaStream();
  for (const t of local.getVideoTracks()) {
    local.removeTrack(t);
    t.stop();
  }
  if (track) {
    local.addTrack(track);
    watchTrack(track);
  }
  const next = new MediaStream(local.getTracks());
  set({ local: next, preview: next, camera: on });
  // refreshBlur puts the camera (blurred or not) on every connection.
  await serial(refreshBlur);
  update({ video: on });
}

export function toggleHold(): void {
  const onHold = !useCall.getState().onHold;
  const { local, muted } = useCall.getState();
  for (const t of local?.getTracks() ?? []) t.enabled = !onHold && (t.kind !== 'audio' || !muted);
  for (const link of links.values()) link.audioEl.muted = onHold;
  set({ onHold });
  update({ onHold });
}

function attachScreen(link: PeerLink): void {
  const track = useCall.getState().localScreen?.getVideoTracks()[0];
  if (!track) return;
  if (link.screenSender) {
    void link.screenSender.replaceTrack(track);
    const t = link.pc.getTransceivers().find((x) => x.sender === link.screenSender);
    if (t) t.direction = 'sendonly';
    return;
  }
  link.screenSender = link.pc.addTransceiver(track, { direction: 'sendonly' }).sender;
}

export async function startShare(source: ScreenSource): Promise<void> {
  const call = useCall.getState().call;
  if (!call) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: source.id,
          maxWidth: 1920,
          maxHeight: 1080,
          maxFrameRate: 15,
        },
      } as unknown as MediaTrackConstraints,
    });
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    // Sharp text over smooth motion.
    track.contentHint = 'detail';
    track.onended = () => void stopShare();
    stopLocalScreen();
    shareStartedAt = Date.now();
    set({ localScreen: stream, sharing: true });
    for (const link of links.values()) attachScreen(link);
    update({ sharing: true });
    void core.invoke('screen.border', { sourceId: source.id }).catch(() => {});
  } catch (err) {
    set({ error: err instanceof Error ? err.message : String(err) });
  }
}

function stopLocalScreen(): void {
  for (const t of useCall.getState().localScreen?.getTracks() ?? []) t.stop();
}

export async function stopShare(): Promise<void> {
  if (!useCall.getState().sharing) return;
  stopLocalScreen();
  for (const link of links.values()) {
    if (!link.screenSender) continue;
    await link.screenSender.replaceTrack(null);
    const t = link.pc.getTransceivers().find((x) => x.sender === link.screenSender);
    if (t) t.direction = 'inactive';
  }
  set({ localScreen: undefined, sharing: false });
  update({ sharing: false });
  void core.invoke('screen.border', { sourceId: null }).catch(() => {});
}

export function inviteToCall(userIds: string[]): void {
  const call = useCall.getState().call;
  if (call)
    void core
      .invoke('calls.invite', { callId: call.callId, userIds })
      .catch((err: unknown) => set({ error: err instanceof Error ? err.message : String(err) }));
}

export function setCallView(view: 'full' | 'mini'): void {
  set({ view });
}

/** Figures for tests and diagnostics: connection times, renegotiation collisions, media flow. */
export async function callStats(): Promise<
  Array<{
    userId: string;
    state: RTCPeerConnectionState;
    connectedMs: number | undefined;
    rollbacks: number;
    audioPackets: number;
    videoFrames: number;
    heartbeat: RTCDataChannelState;
    lastHeardMs: number;
    transceivers: string[];
  }>
> {
  const out = [];
  for (const link of links.values()) {
    let audioPackets = 0;
    let videoFrames = 0;
    const report = await link.pc.getStats();
    report.forEach(
      (s: { type: string; kind?: string; packetsReceived?: number; framesDecoded?: number }) => {
        if (s.type !== 'inbound-rtp') return;
        if (s.kind === 'audio') audioPackets += s.packetsReceived ?? 0;
        if (s.kind === 'video') videoFrames += s.framesDecoded ?? 0;
      },
    );
    const start = acceptedAt ?? link.createdAt;
    out.push({
      userId: link.userId,
      state: link.pc.connectionState,
      connectedMs: link.connectedAt === undefined ? undefined : link.connectedAt - start,
      rollbacks: link.rollbacks,
      audioPackets,
      videoFrames,
      heartbeat: link.heartbeat.readyState,
      lastHeardMs: link.lastHeard ? Date.now() - link.lastHeard : -1,
      transceivers: link.pc
        .getTransceivers()
        .map(
          (t) =>
            `${t.mid}:${t.receiver.track.kind}:${t.direction}/${t.currentDirection}:${t.sender.track ? 'send' : '-'}:${t.receiver.track.muted ? 'muted' : 'live'}`,
        ),
    });
  }
  return out;
}

export function initCalls(): void {
  // Going elsewhere in the app during a call shrinks it to the mini view.
  useApp.subscribe((s, prev) => {
    if (s.rail === prev.rail && s.selectedConv === prev.selectedConv) return;
    const { call, view } = useCall.getState();
    if (call && call.state !== 'ringing' && view === 'full') set({ view: 'mini' });
  });
  core.on('call.changed', (payload) => void serial(() => onCallChanged(payload)));
  core.on('call.signal', (payload) => void serial(() => onSignal(payload)));
  core.on('call.ended', (payload) => {
    if (payload.outcome !== 'completed') {
      set({ notice: payload });
      window.setTimeout(() => {
        if (useCall.getState().notice === payload) set({ notice: undefined });
      }, 8_000);
    }
  });
  void core
    .invoke('calls.current', {})
    .then((call) => call && serial(() => onCallChanged({ call })));
  // Short messages to this user clear themselves after a while.
  useCall.subscribe((s, prev) => {
    if (!s.message || s.message === prev.message) return;
    const shown = s.message;
    window.setTimeout(() => {
      if (useCall.getState().message === shown) set({ message: undefined });
    }, 8_000);
  });
  core.on('call.reaction', ({ callId: id, from, emoji }) => {
    if (id === callId) showReaction(from, emoji);
  });
  core.on('call.controlled', ({ callId: id, action }) => {
    if (id !== callId) return;
    if (action === 'mute') {
      const mic = micTrack();
      if (mic) mic.enabled = false;
      set({ muted: true, message: 'The organiser muted you.' });
    } else {
      teardown();
      set({ message: 'The organiser removed you from the meeting.' });
    }
  });
  Object.assign(window as object, {
    officemeshCallStats: callStats,
    officemeshBlurStats: () => ({
      on: blurPipe !== undefined,
      fps: blurPipe?.fps ?? 0,
      inputFps: blurPipe?.inputFps ?? 0,
    }),
    officemeshWhiteboard: whiteboardJson,
  });
}
