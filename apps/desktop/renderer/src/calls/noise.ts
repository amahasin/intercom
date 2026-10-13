/**
 * The microphone track run through a high-pass filter and the gate (which runs on the audio
 * thread, see `gate.worklet.ts`). The returned track behaves like a microphone track: stopping it
 * stops the chain and the real microphone, enabling and disabling it mutes, and it ends when the
 * device does.
 */
export async function suppress(raw: MediaStreamTrack): Promise<MediaStreamTrack> {
  const context = new AudioContext({ latencyHint: 'interactive' });
  try {
    // Served by the app itself, next to the page (see scripts/build.mjs).
    await context.audioWorklet.addModule(new URL('./gate-worklet.js', document.baseURI).href);
  } catch (err) {
    void context.close();
    throw err;
  }
  const source = context.createMediaStreamSource(new MediaStream([raw]));
  const highpass = context.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 100;
  const gate = new AudioWorkletNode(context, 'intercom-gate', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
  });
  const destination = context.createMediaStreamDestination();
  source.connect(highpass).connect(gate).connect(destination);
  void context.resume();
  // A hook for the tests: the gate is running on the audio thread.
  (window as unknown as { officemeshGate?: string }).officemeshGate = 'worklet';

  const track = destination.stream.getAudioTracks()[0]!;
  const stop = track.stop.bind(track);
  let stopped = false;
  track.stop = () => {
    if (stopped) return;
    stopped = true;
    source.disconnect();
    gate.disconnect();
    raw.stop();
    stop();
    void context.close();
  };
  // The device going away ends the sent track too, so the call reopens it.
  raw.addEventListener('ended', () => track.dispatchEvent(new Event('ended')));
  return track;
}
