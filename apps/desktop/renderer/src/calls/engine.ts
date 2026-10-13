/**
 * The call's media: one RTCPeerConnection per other participant (full mesh, plan section
 * 9), with "perfect negotiation" so simultaneous renegotiations (camera toggles, screen
 * share) resolve instead of deadlocking. Signaling goes through the core, which signs SDP
 * and relays it over the peer link. Lives outside React so media survives view changes.
 */
import { create } from 'zustand';
import type { CallSignal, CallView, IpcEventPayload, ScreenSource } from '@officemesh/protocol/ipc';
import { RELAY_JOIN_MUTED_ABOVE, type CALL_REACTIONS, type MsgRef } from '@officemesh/protocol';
import { core, displayName, useApp } from '../state.ts';
import { strings } from '../strings.ts';
import { BlurPipeline } from './blur.ts';
import { Recorder, type RecordingSources } from './recorder.ts';
import {
  attachControl,
  detachControl,
  endControl,
  initRemote,
  setRemoteContext,
  setShareKind,
} from './remote.ts';
import { playCue, soundLog, syncLoop } from './sounds.ts';
import { micConstraints } from './gate.ts';
import { judgeLink, ORPHAN_GRACE_MS, PROBE_AFTER_MS } from './liveness.ts';
import { suppress } from './noise.ts';
import { RelayMedia, type RelayRemote } from './relay.ts';
import {
  attachWhiteboard,
  detachWhiteboard,
  resetWhiteboard,
  whiteboardJson,
} from './whiteboard.ts';

/** A gap this long between two ticks means this window was stalled, not that the others went quiet. */
const STALL_MS = 3_000;
const HEARTBEAT_MS = 1_000;
/** Above this many people, video steps down to 360p per tile (plan section 9). */
const LOW_RES_ABOVE = 4;
/** Above this many people, only the 4 most recent speakers send video. */
const SPEAKERS_ONLY_ABOVE = 6;
const VIDEO_SPEAKERS = 4;
const SPEAKING_LEVEL = 0.04;

/** What the call window says for a moment after a call ends, before it closes. */
export interface EndedCall {
  callId: string;
  outcome: IpcEventPayload<'call.ended'>['outcome'];
  /** Whom the call was with (a colleague, or a group's name). */
  who: string;
  /** How long it lasted, if it was ever answered. */
  durationMs: number | undefined;
  direction: 'in' | 'out';
  /** The first colleague who did not join, and why (an outgoing call that did not connect). */
  decline: { name: string; reason: string } | undefined;
  /** A single colleague to call back, if it was a 1:1 call. */
  peer: string | undefined;
  media: 'audio' | 'video';
  /** The call window (`full`) or the small card (an incoming call, or while working elsewhere). */
  view: 'full' | 'card';
}

/** How long the "call ended" message stays up. */
const ENDED_SHOWN_MS = 2_600;

export interface RemoteMedia {
  userId: string;
  camera: MediaStream | undefined;
  screen: MediaStream | undefined;
  state: RTCPeerConnectionState;
  speaking: boolean;
}

interface CallUi {
  call: CallView | null;
  /** Every call this PC is in, ringing for or has on hold (the main window and the ring window). */
  all: CallView[];
  local: MediaStream | undefined;
  localScreen: MediaStream | undefined;
  muted: boolean;
  camera: boolean;
  onHold: boolean;
  sharing: boolean;
  speaking: boolean;
  remotes: Record<string, RemoteMedia>;
  /** The "call ended" message, shown for a moment where the call was. */
  ending: EndedCall | undefined;
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
  /** The people list beside the call (one side panel at a time: this or the chat). */
  peopleOpen: boolean;
  /** On host relay: this PC's load while it hosts (M6). */
  relayStats: IpcEventPayload<'call.relayStats'> | undefined;
  /** On host relay: the page of cameras shown, and how many cameras there are. */
  page: number;
  cameraCount: number;
}

export const useCall = create<CallUi>(() => ({
  call: null,
  all: [],
  local: undefined,
  localScreen: undefined,
  muted: false,
  camera: false,
  onHold: false,
  sharing: false,
  speaking: false,
  remotes: {},
  ending: undefined,
  error: undefined,
  message: undefined,
  blur: false,
  preview: undefined,
  recording: false,
  reactions: [],
  layout: 'gallery',
  chatOpen: false,
  peopleOpen: false,
  relayStats: undefined,
  page: 0,
  cameraCount: 0,
}));

class PeerLink {
  readonly pc: RTCPeerConnection;
  readonly userId: string;
  readonly polite: boolean;
  readonly heartbeat: RTCDataChannel;
  readonly whiteboard: RTCDataChannel;
  /** Remote control requests and input (see remote.ts); peers without it never open it. */
  readonly control: RTCDataChannel;
  makingOffer = false;
  ignoreOffer = false;
  rollbacks = 0;
  createdAt = Date.now();
  connectedAt: number | undefined;
  lastHeard = 0;
  /** When the connection was last restarted, and the media bytes seen then (liveness probe). */
  lastRestart = 0;
  rxBytes = 0;
  probing = false;
  failedSince: number | undefined;
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
    this.control = this.pc.createDataChannel('control', { negotiated: true, id: 2 });
    this.audioEl = document.createElement('audio');
    this.audioEl.autoplay = true;
    this.audioEl.dataset['peer'] = userId;
    document.body.append(this.audioEl);
  }

  close(): void {
    this.heartbeat.close();
    this.whiteboard.close();
    this.control.close();
    this.pc.close();
    this.audioEl.srcObject = null;
    this.audioEl.remove();
  }
}

/**
 * Which window this is. The main window and the small incoming-call window only follow what
 * the calls are doing; the call window of a call runs its media (one call per window).
 */
export type CallRole = 'main' | 'call' | 'incoming';
let role: CallRole = 'main';
/** The call this (call or incoming) window belongs to. */
let boundCall: string | undefined;

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

/** The sound this PC sends is cleaned up as the user chose (Settings > Calls, or the mic menu). */
function noiseLevel(): 'off' | 'standard' | 'high' {
  return useApp.getState().settings?.noiseSuppression ?? 'high';
}

/**
 * Make sure the microphone is processed as the setting says. The browser can hand back a capture
 * with other processing than asked for (see `reopenDevice`); the constraints are applied again if
 * what it reports differs.
 */
async function enforceMic(stream: MediaStream): Promise<void> {
  const track = stream.getAudioTracks()[0];
  if (!track) return;
  const want = micConstraints(noiseLevel());
  const have = track.getSettings();
  const differs =
    have.noiseSuppression !== want.noiseSuppression ||
    have.echoCancellation !== want.echoCancellation ||
    have.autoGainControl !== want.autoGainControl;
  if (differs) await track.applyConstraints(want).catch(() => {});
}

/** In "high", the microphone track is replaced by one that has been through the gate. */
async function cleaned(stream: MediaStream): Promise<MediaStream> {
  if (noiseLevel() !== 'high') return stream;
  const raw = stream.getAudioTracks()[0];
  if (!raw) return stream;
  try {
    const clean = await suppress(raw);
    stream.removeTrack(raw);
    stream.addTrack(clean);
  } catch (err) {
    // The gate could not start: the browser's own suppression still applies.
    console.warn('noise gate unavailable', err);
  }
  return stream;
}

/** Apply a changed noise setting to the open microphone now. */
export function reapplyAudio(): void {
  if (useCall.getState().local) void serial(() => reopenDevice('audio', true));
}

async function openLocal(video: boolean): Promise<MediaStream> {
  const settings = useApp.getState().settings;
  const audio = {
    ...micConstraints(noiseLevel()),
    ...deviceConstraint(settings?.audioInput),
  };
  const cam = {
    width: 1280,
    height: 720,
    frameRate: 30,
    ...deviceConstraint(settings?.videoInput),
  };
  try {
    const stream = await getMedia({ audio, video: video ? cam : false });
    await enforceMic(stream);
    return await cleaned(stream);
  } catch {
    // A chosen device that went away: fall back to the defaults.
    return await cleaned(
      await getMedia({
        audio: micConstraints(noiseLevel()),
        video: video ? { width: 1280, height: 720 } : false,
      }),
    );
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
  if (relay) {
    await relay.setSource('camera', useCall.getState().camera ? cameraTrack() : null);
    return;
  }
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
    ...[...relayAudio.values()].map((el) => el.srcObject as MediaStream),
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
    // A video call has a camera line first; an audio call has none, so any video in it is
    // a screen (the first video line is not "the camera" there).
    if (useCall.getState().call?.media === 'video') link.cameraTransceiver ??= transceiver;
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
  // Anything that arrives shows the other side is there (a big whiteboard picture can hold up the
  // heartbeat behind it).
  const heard = () => {
    link.lastHeard = Date.now();
  };
  link.heartbeat.onmessage = heard;
  link.whiteboard.addEventListener('message', heard);
  link.control.addEventListener('message', heard);
  attachWhiteboard(userId, link.whiteboard);
  attachControl(userId, link.control);
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
  detachControl(userId);
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

/** The main and incoming windows: keep the list of calls, show the one that matters. */
function follow(call: CallView | null, endedId: string | undefined): void {
  const was = useCall.getState().all;
  const all = call
    ? [...was.filter((c) => c.callId !== call.callId), call]
    : endedId
      ? was.filter((c) => c.callId !== endedId)
      : [];
  // Main: the call being talked in, else one on hold, else one ringing. Incoming: its own.
  const shown =
    role === 'incoming'
      ? all.find((c) => c.callId === boundCall)
      : (all.find((c) => c.state !== 'ringing' && !c.held) ??
        all.find((c) => c.state !== 'ringing') ??
        all[0]);
  if (shown) lastCall = shown;
  // The incoming window keeps showing its call (as it was) while it says how it ended.
  set({ all, call: shown ?? (role === 'incoming' ? useCall.getState().call : null) });
}

async function onCallChanged({
  call,
  callId: endedId,
}: IpcEventPayload<'call.changed'>): Promise<void> {
  if (role !== 'call') {
    follow(call, endedId);
    return;
  }
  if (!call) {
    // That call is over (or none is left): this window's call, whichever it was.
    if (!endedId || endedId === boundCall) teardown();
    return;
  }
  if (call.callId !== boundCall) return;
  const prev = useCall.getState().call;
  // Updates queued before the call ended can arrive after the news that it ended.
  if (call.callId === lastEndedCallId) return;
  if (call.callId !== callId) resetWhiteboard();
  callId = call.callId;
  selfId = useApp.getState().identity?.userId ?? selfId;
  lastCall = call;
  set({ call, ending: undefined });
  // Put on hold (or taken off it) by the core, to take another call: follow it.
  const myEntry = call.participants.find((p) => p.userId === selfId);
  if (myEntry && myEntry.onHold !== useCall.getState().onHold) applyHold(myEntry.onHold);
  if (call.state === 'ringing') return;
  if (!useCall.getState().local) await beginMedia(call);
  if (call.relay) {
    await onRelayCall(call);
    return;
  }
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
  // An offer can arrive before the roster that lists its sender: that link stays for a while.
  for (const [userId, link] of links)
    if (!present.has(userId) && Date.now() - link.createdAt > ORPHAN_GRACE_MS) dropLink(userId);
  connectMissing(call);
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
  // A microphone that is still open keeps the processing it was opened with: Chromium shares one
  // capture between streams on a device, and echo cancellation, noise suppression and gain are
  // fixed when the first of them opens it. So a new noise setting only takes effect once the old
  // microphone has been let go (which is why it used to work after switching off and back).
  if (kind === 'audio' && force) {
    const old = useCall.getState().local;
    for (const t of old?.getAudioTracks() ?? []) {
      old?.removeTrack(t);
      t.stop();
    }
  }
  try {
    const stream = await getMedia(
      kind === 'audio'
        ? {
            audio: {
              ...micConstraints(noiseLevel()),
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
    if (kind === 'audio') await enforceMic(stream);
    fresh = (kind === 'audio' ? await cleaned(stream) : stream).getTracks()[0];
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
  if (relay) {
    if (kind === 'audio') {
      const s = useCall.getState();
      await relay.setSource('mic', fresh, s.muted || s.onHold);
    }
  }
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

/** Start the link to everyone this user is to connect to and has no link with yet. */
function connectMissing(call: CallView): void {
  const me = call.participants.find((p) => p.userId === selfId);
  for (const p of others(call)) {
    if (links.has(p.userId)) continue;
    // The later joiner connects; the other side answers when the offer arrives.
    if (me && (p.joinedAt < me.joinedAt || (p.joinedAt === me.joinedAt && p.userId < selfId))) {
      startLink(p.userId);
    }
  }
}

/**
 * Sound or picture still coming in from a link counts as hearing from it, even when its
 * heartbeat is held up. One probe at a time per link.
 */
function probeMedia(link: PeerLink): void {
  if (link.probing) return;
  link.probing = true;
  void link.pc
    .getStats()
    .then((report) => {
      let bytes = 0;
      report.forEach((r: { type: string; bytesReceived?: number }) => {
        if (r.type === 'inbound-rtp') bytes += r.bytesReceived ?? 0;
      });
      // The first sample is only the baseline: there is nothing yet to say it grew.
      if (link.rxBytes > 0 && bytes > link.rxBytes) link.lastHeard = Date.now();
      link.rxBytes = bytes;
    })
    .catch(() => {})
    .finally(() => {
      link.probing = false;
    });
}

let lastTickAt = 0;

function tick(): void {
  const now = Date.now();
  const state = useCall.getState();
  checkDevices(now);
  // This window was stalled (busy, or the PC was): the silence is ours, not theirs.
  const stalled = lastTickAt > 0 && now - lastTickAt > STALL_MS;
  lastTickAt = now;
  const call = state.call;
  const mesh = call !== null && !call.relay;
  const roster = new Set(call?.participants.map((p) => p.userId));
  // Heartbeats, and dropping participants who went silent.
  for (const link of [...links.values()]) {
    if (link.heartbeat.readyState === 'open') link.heartbeat.send('.');
    if (stalled) link.lastHeard = now;
    if (mesh && !roster.has(link.userId) && now - link.createdAt > ORPHAN_GRACE_MS) {
      dropLink(link.userId);
      continue;
    }
    const failed = link.pc.connectionState === 'failed';
    if (failed) link.failedSince ??= now;
    else link.failedSince = undefined;
    const connected = link.connectedAt !== undefined;
    const quiet = now - (connected ? link.lastHeard : link.createdAt);
    if (connected && quiet > PROBE_AFTER_MS) probeMedia(link);
    const verdict = judgeLink({
      connected,
      quietMs: quiet,
      failedMs: link.failedSince === undefined ? 0 : now - link.failedSince,
      sinceRestartMs: now - link.lastRestart,
    });
    if (verdict === 'drop' && callId) {
      void core.invoke('calls.dropped', { callId, userId: link.userId }).catch(() => {});
      dropLink(link.userId);
      continue;
    }
    if (verdict === 'restart') {
      link.lastRestart = now;
      try {
        link.pc.restartIce();
      } catch {
        // already closing
      }
    }
    const speaking = level(link.analyser) > SPEAKING_LEVEL;
    if (state.remotes[link.userId]?.speaking !== speaking) setRemote(link.userId, { speaking });
  }
  // A link that was never made (an offer that arrived before the roster, say) is made now.
  if (mesh && call.state !== 'ringing') connectMissing(call);
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
  setShareKind(null);
  endControl();
  if (recorder) void stopRecording();
  closeRelay();
  relayJoined = undefined;
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
    peopleOpen: false,
    relayStats: undefined,
    page: 0,
    cameraCount: 0,
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

/**
 * Starting, answering and joining only tell the core. The call window that opens for the
 * call (main opens it) runs the media; this window carries on with what it was doing.
 */
export async function startCall(userIds: string[], media: 'audio' | 'video', convId?: string) {
  try {
    await core.invoke('calls.start', { userIds, media, ...(convId && { convId }) });
  } catch (err) {
    set({ message: err instanceof Error ? err.message : String(err) });
  }
}

/** Answer the ringing call; `how` is what happens to the call already going on, if any. */
export async function acceptCall(video: boolean, how?: 'hold' | 'end'): Promise<void> {
  const call = useCall.getState().call;
  if (!call) return;
  try {
    await core.invoke('calls.accept', { callId: call.callId, video, ...(how && { how }) });
  } catch (err) {
    set({ message: err instanceof Error ? err.message : String(err) });
  }
}

/** Add the waiting call's caller to the call this user is in. */
export async function mergeCall(): Promise<void> {
  const call = useCall.getState().call;
  if (!call) return;
  try {
    await core.invoke('calls.merge', { callId: call.callId });
  } catch (err) {
    set({ message: err instanceof Error ? err.message : String(err) });
  }
  window.officemeshWindow?.close();
}

/** Meet now in a chat or channel (or join the meeting already running there). */
export async function meetNow(
  convId: string,
  media: 'audio' | 'video',
  meeting?: MsgRef,
): Promise<void> {
  try {
    await core.invoke('calls.meetNow', { convId, media, ...(meeting && { meeting }) });
  } catch (err) {
    set({ message: err instanceof Error ? err.message : String(err) });
  }
}

/** Join the meeting a "call started" card announces. */
export async function joinMeeting(convId: string, target: MsgRef): Promise<void> {
  try {
    await core.invoke('calls.join', { convId, target });
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
  set({ chatOpen, ...(chatOpen && { peopleOpen: false }) });
}

export function setPeopleOpen(peopleOpen: boolean): void {
  set({ peopleOpen, ...(peopleOpen && { chatOpen: false }) });
}

/** Switch microphone, camera or speaker during a call (plan section 9). */
export async function switchDevice(
  kind: 'audioInput' | 'videoInput' | 'audioOutput',
  deviceId: string,
): Promise<void> {
  useApp.setState({ settings: await core.invoke('settings.set', { [kind]: deviceId }) });
  if (kind === 'audioOutput') {
    for (const link of links.values()) applySink(link.audioEl);
    for (const el of relayAudio.values()) applySink(el);
    return;
  }
  await serial(async () => {
    await reopenDevice(kind === 'audioInput' ? 'audio' : 'video', true);
  });
}

export function declineCall(): void {
  const call = useCall.getState().call;
  if (call) void core.invoke('calls.decline', { callId: call.callId });
  // The ring window then says "Call declined" for a moment, like every other ending.
}

/** Leave the call: only this person goes; the others carry on. */
export function hangUp(): void {
  const call = useCall.getState().call;
  if (call) void core.invoke('calls.hangup', { callId: call.callId });
  teardown();
}

/** The organiser ends the call for every participant. */
export function endForAll(): void {
  const call = useCall.getState().call;
  if (call) void core.invoke('calls.endForAll', { callId: call.callId });
  teardown();
}

export function toggleMute(): void {
  const muted = !useCall.getState().muted;
  const mic = micTrack();
  if (mic) mic.enabled = !muted && !useCall.getState().onHold;
  set({ muted });
  update({ muted });
  void relay?.pause('mic', muted || useCall.getState().onHold);
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

/** Silence this end of the call (or bring it back): microphone, camera and what we hear. */
function applyHold(onHold: boolean): void {
  const { local, muted } = useCall.getState();
  for (const t of local?.getTracks() ?? []) t.enabled = !onHold && (t.kind !== 'audio' || !muted);
  for (const link of links.values()) link.audioEl.muted = onHold;
  for (const el of relayAudio.values()) el.muted = onHold;
  set({ onHold });
  void relay?.pause('mic', onHold || muted);
}

export function toggleHold(): void {
  const { onHold, call } = useCall.getState();
  // A call put on hold to take another comes back through the core, which puts the other
  // one on hold; the roster then tells this window to start talking again.
  if (onHold && call?.held) {
    void core.invoke('calls.resume', { callId: call.callId }).catch(() => {});
    return;
  }
  applyHold(!onHold);
  update({ onHold: !onHold });
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
  void tuneScreenSender(link.screenSender);
}

/**
 * Let the screen use what a LAN offers: the browser starts a share at a few hundred kbit/s and
 * lets it drop to a fraction of the size when it thinks the link is busy. Ask for up to 25 Mbit/s,
 * 30 frames a second, never smaller than the screen, and give up frames before sharpness.
 */
async function tuneScreenSender(sender: RTCRtpSender): Promise<void> {
  try {
    const params = sender.getParameters();
    const encoding = params.encodings?.[0] ?? {};
    encoding.maxBitrate = 25_000_000;
    encoding.maxFramerate = 30;
    encoding.scaleResolutionDownBy = 1;
    params.encodings = [encoding];
    (params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference =
      'maintain-resolution';
    await sender.setParameters(params);
  } catch {
    // The browser keeps its defaults.
  }
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
          // The screen at its own size and a smooth frame rate: this is a LAN, and text and
          // drawings are what people look at (it used to be 1080p at 15 frames a second).
          maxWidth: 3840,
          maxHeight: 2160,
          minFrameRate: 15,
          maxFrameRate: 30,
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
    setShareKind(source.kind === 'screen' ? 'screen' : 'window');
    set({ localScreen: stream, sharing: true });
    for (const link of links.values()) attachScreen(link);
    void relay?.setSource('screen', track);
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
  setShareKind(null);
  stopLocalScreen();
  for (const link of links.values()) {
    if (!link.screenSender) continue;
    await link.screenSender.replaceTrack(null);
    const t = link.pc.getTransceivers().find((x) => x.sender === link.screenSender);
    if (t) t.direction = 'inactive';
  }
  set({ localScreen: undefined, sharing: false });
  update({ sharing: false });
  void relay?.setSource('screen', null);
  void core.invoke('screen.border', { sourceId: null }).catch(() => {});
}

export function inviteToCall(userIds: string[]): void {
  const call = useCall.getState().call;
  if (call)
    void core
      .invoke('calls.invite', { callId: call.callId, userIds })
      .catch((err: unknown) => set({ error: err instanceof Error ? err.message : String(err) }));
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
  if (relay) {
    const s = await relay.stats();
    out.push({
      userId: useCall.getState().call?.relay?.host ?? '',
      state: (relay.connectedAt ? 'connected' : 'connecting') as RTCPeerConnectionState,
      connectedMs:
        relay.connectedAt === undefined
          ? undefined
          : relay.connectedAt - (acceptedAt ?? relay.startedAt),
      rollbacks: 0,
      audioPackets: s.audioPackets,
      videoFrames: s.videoFrames,
      heartbeat: 'open' as RTCDataChannelState,
      lastHeardMs: 0,
      transceivers: [`relay epoch ${relay.epoch}: ${s.consumers} streams`],
    });
  }
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

// ---------------------------------------------------------------------------
// Host relay (M6)
// ---------------------------------------------------------------------------

let relay: RelayMedia | undefined;
const relayAudio = new Map<string, HTMLAudioElement>();
/** The call whose relay we first entered (newcomers above 25 join muted, once). */
let relayJoined: string | undefined;

function closeRelay(): void {
  relay?.close();
  relay = undefined;
  for (const el of relayAudio.values()) {
    el.srcObject = null;
    el.remove();
  }
  relayAudio.clear();
}

function onRelayAdded(remote: RelayRemote): void {
  if (remote.kind === 'audio') {
    const el = document.createElement('audio');
    el.autoplay = true;
    el.dataset['peer'] = remote.userId;
    el.srcObject = new MediaStream([remote.track]);
    el.muted = useCall.getState().onHold;
    applySink(el);
    document.body.append(el);
    relayAudio.set(remote.consumerId, el);
    return;
  }
  const stream = new MediaStream([remote.track]);
  setRemote(remote.userId, {
    state: 'connected',
    ...(remote.source === 'screen' ? { screen: stream } : { camera: stream }),
  });
}

function onRelayRemoved(remote: RelayRemote): void {
  const el = relayAudio.get(remote.consumerId);
  if (el) {
    el.srcObject = null;
    el.remove();
    relayAudio.delete(remote.consumerId);
    return;
  }
  const current = useCall.getState().remotes[remote.userId];
  const key = remote.source === 'screen' ? 'screen' : 'camera';
  if (current?.[key]?.getTracks()[0] === remote.track)
    setRemote(remote.userId, { [key]: undefined });
}

/** A call on host relay: one connection to the host, rebuilt at each hand-over. */
async function onRelayCall(call: CallView): Promise<void> {
  for (const userId of [...links.keys()]) dropLink(userId);
  const r = call.relay!;
  // Drop remote tiles of people who left.
  const present = new Set(call.participants.map((p) => p.userId));
  useCall.setState((s) => ({
    remotes: Object.fromEntries(Object.entries(s.remotes).filter(([u]) => present.has(u))),
  }));
  if (r.reconnecting) {
    // The host is changing: let go of the old one; the new one is joined by the core.
    if (relay && relay.epoch !== r.epoch) closeRelay();
    return;
  }
  if (relay?.epoch === r.epoch) return;
  closeRelay();
  // Above 25 people, newcomers join muted with their camera off (plan section 9).
  if (relayJoined !== call.callId) {
    relayJoined = call.callId;
    if (call.participants.length > RELAY_JOIN_MUTED_ABOVE && !useCall.getState().muted) {
      toggleMute();
      set({ message: 'You joined muted: this is a large meeting.' });
    }
    if (call.participants.length > RELAY_JOIN_MUTED_ABOVE && useCall.getState().camera)
      void toggleCamera();
  }
  const media = new RelayMedia(call.callId, r.epoch, {
    added: onRelayAdded,
    removed: onRelayRemoved,
    speakers: (ids) => {
      const loud = new Set(ids);
      useCall.setState((s) => ({
        remotes: Object.fromEntries(
          Object.entries(s.remotes).map(([u, m]) => [u, { ...m, speaking: loud.has(u) }]),
        ),
      }));
    },
    senderPaused: () => {},
    cameras: (count) => {
      if (useCall.getState().cameraCount !== count) set({ cameraCount: count });
    },
  });
  relay = media;
  try {
    await media.start();
    const s = useCall.getState();
    await media.setSource('mic', micTrack(), s.muted || s.onHold);
    if (s.camera && call.media === 'video') await media.setSource('camera', cameraTrack());
    const screen = s.localScreen?.getVideoTracks()[0];
    if (screen) await media.setSource('screen', screen);
    if (s.page > 0) await media.setView(s.page);
  } catch (err) {
    if (relay === media) set({ error: err instanceof Error ? err.message : String(err) });
  }
}

/** Show another page of cameras (relay: the host sends 9 at a time, recent speakers first). */
export function setCameraPage(page: number): void {
  set({ page });
  void relay?.setView(page);
}

let lastCall: CallView | undefined;
/** The call that ended most recently, so a late reply for it is not shown as a live call. */
let lastEndedCallId: string | undefined;

/** Show the end of a call where it was, and play its sound (plan: every call ends audibly). */
function onCallEnded(payload: IpcEventPayload<'call.ended'>): void {
  // Each window shows the end of its own call; the main window shows nothing.
  if (role === 'main' || payload.callId !== boundCall) return;
  lastEndedCallId = payload.callId;
  const open = useCall.getState();
  const call = open.call?.callId === payload.callId ? open.call : lastCall;
  const mine = call?.callId === payload.callId ? call : undefined;
  const others = (mine?.participants ?? []).filter((p) => p.userId !== selfId);
  const group = (mine?.participants.length ?? 0) > 2;
  const conversationTitle = mine?.convId
    ? useApp.getState().conversations[mine.convId]?.title
    : undefined;
  const peerId =
    others.length === 1
      ? others[0]!.userId
      : others.length === 0 && mine && !group
        ? (mine.invited[0] ?? mine.caller)
        : undefined;
  const first = payload.declines[0];
  const view: 'full' | 'card' = role === 'incoming' ? 'card' : 'full';
  const ending: EndedCall = {
    callId: payload.callId,
    outcome: payload.outcome,
    who: group
      ? (conversationTitle ?? strings.calls.people(others.length + 1))
      : peerId
        ? displayName(peerId)
        : (conversationTitle ?? ''),
    durationMs: mine?.answeredAt ? Date.now() - mine.answeredAt : undefined,
    direction: mine?.direction ?? 'out',
    decline: first ? { name: displayName(first.userId), reason: first.reason } : undefined,
    peer: group ? undefined : peerId,
    media: mine?.media ?? 'audio',
    view,
  };
  playCue(
    payload.outcome === 'completed' || payload.outcome === 'cancelled'
      ? 'ended'
      : payload.outcome === 'missed'
        ? 'missed'
        : payload.outcome === 'declined'
          ? 'declined'
          : 'unavailable',
  );
  set({ ending });
  window.setTimeout(() => {
    if (useCall.getState().ending === ending) set({ ending: undefined });
  }, ENDED_SHOWN_MS);
}

/** Close the "call ended" message now. */
export function dismissEnding(): void {
  set({ ending: undefined });
}

export function initCalls(as: CallRole = 'main', bound?: string): void {
  role = as;
  boundCall = bound;
  selfId = useApp.getState().identity?.userId ?? '';
  core.on('call.changed', (payload) => void serial(() => onCallChanged(payload)));
  core.on('call.ended', onCallEnded);
  if (role === 'call') {
    setRemoteContext({
      name: (id) => displayName(id),
      sharing: (id) =>
        useCall.getState().call?.participants.some((p) => p.userId === id && p.sharing) === true,
    });
    initRemote();
    core.on('call.signal', (payload) => void serial(() => onSignal(payload)));
    // A noise setting changed anywhere (this window's menu, or Settings in the main window) is
    // applied to the open microphone at once.
    let noise = noiseLevel();
    useApp.subscribe(() => {
      const now = noiseLevel();
      if (now === noise) return;
      noise = now;
      reapplyAudio();
    });
    // The ringback (for the caller) and the "connected" chime follow what the call is doing.
    useCall.subscribe((s, prev) => {
      const call = s.call;
      const waiting =
        call?.state === 'outgoing' &&
        call.direction === 'out' &&
        call.participants.every((p) => p.userId === selfId);
      syncLoop('ringback', waiting);
      if (prev.call?.state === 'outgoing' && call?.state === 'active' && call.direction === 'out')
        playCue('connected');
    });
  }
  if (role === 'incoming') {
    // The ring (a tune for a call, soft pings when the user is already in another).
    useCall.subscribe((s) => {
      const call = s.call;
      const ringing = call?.state === 'ringing' && !s.ending;
      syncLoop('ringtone', ringing && !call?.waiting);
      syncLoop('waiting', ringing && call?.waiting === true);
    });
  }
  // Each window learns of the calls that exist now (a call window finds its own).
  void core.invoke('calls.list', {}).then(async (calls) => {
    for (const call of calls) void serial(() => onCallChanged({ call }));
    // A call that failed in an instant ended before this window had opened: ask how.
    if (role !== 'main' && boundCall && !calls.some((c) => c.callId === boundCall)) {
      const ended = await core.invoke('calls.ended', { callId: boundCall }).catch(() => null);
      if (ended) {
        lastCall = ended.call;
        onCallEnded({ callId: boundCall, outcome: ended.outcome, declines: ended.declines });
      }
    }
  });
  // Short messages to this user clear themselves after a while.
  useCall.subscribe((s, prev) => {
    if (!s.message || s.message === prev.message) return;
    const shown = s.message;
    window.setTimeout(() => {
      if (useCall.getState().message === shown) set({ message: undefined });
    }, 8_000);
  });
  Object.assign(window as object, {
    officemeshCallStats: callStats,
    officemeshBlurStats: () => ({
      on: blurPipe !== undefined,
      fps: blurPipe?.fps ?? 0,
      inputFps: blurPipe?.inputFps ?? 0,
    }),
    officemeshWhiteboard: whiteboardJson,
    officemeshSounds: soundLog,
    officemeshRelay: async () =>
      relay
        ? {
            epoch: relay.epoch,
            connectedMs:
              relay.connectedAt === undefined ? null : relay.connectedAt - relay.startedAt,
            ...(await relay.stats()),
            remotes: relay.remotes().map((r) => `${r.userId}:${r.source}`),
          }
        : null,
  });
  if (role !== 'call') return;
  core.on('call.relay', ({ callId: id, epoch, method, data }) => {
    if (relay && id === relay.callId && epoch === relay.epoch) void relay.onNotify(method, data);
  });
  core.on('call.relayStats', (stats) => {
    if (stats.callId === callId) set({ relayStats: stats });
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
      set({
        message:
          action === 'end'
            ? strings.calls.endedByOrganizer
            : 'The organiser removed you from the meeting.',
      });
    }
  });
}
