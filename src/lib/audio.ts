const BASIC_PITCH_SAMPLE_RATE = 22050;

export interface DecodedAudio {
  samples: Float32Array;
  duration: number;
  sampleRate: number;
}

export async function decodeToMonoSamples(file: File): Promise<DecodedAudio> {
  const AudioContextCtor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

  if (!AudioContextCtor) {
    throw new Error('This browser does not expose the Web Audio API.');
  }

  const inputBuffer = await file.arrayBuffer();
  const audioContext = new AudioContextCtor();

  try {
    const decoded = await audioContext.decodeAudioData(inputBuffer.slice(0));
    await audioContext.close();

    const length = Math.max(1, Math.ceil(decoded.duration * BASIC_PITCH_SAMPLE_RATE));
    const offlineContext = new OfflineAudioContext(1, length, BASIC_PITCH_SAMPLE_RATE);
    const source = offlineContext.createBufferSource();
    source.buffer = decoded;
    source.connect(offlineContext.destination);
    source.start(0);

    const rendered = await offlineContext.startRendering();
    const samples = rendered.getChannelData(0).slice();

    return {
      samples,
      duration: rendered.duration,
      sampleRate: BASIC_PITCH_SAMPLE_RATE,
    };
  } catch (error) {
    await audioContext.close();
    const browserMessage = error instanceof Error ? error.message : 'The browser could not decode it.';
    throw new Error(
      `This browser could not decode the audio file. Try WAV, MP3, M4A, OGG, FLAC in Chrome, or upload MIDI directly. ${browserMessage}`,
    );
  }
}
