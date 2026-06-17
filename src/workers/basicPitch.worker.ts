import type { BasicPitch, NoteEventTime } from '@spotify/basic-pitch';

type TranscribeMessage = {
  type: 'transcribe';
  modelUrl: string;
  samples: Float32Array;
};

type BasicPitchModule = typeof import('@spotify/basic-pitch');

let basicPitch: BasicPitch | null = null;
let activeModelUrl = '';
let basicPitchModule: BasicPitchModule | null = null;

function installWorkerBrowserShim() {
  const scope = globalThis as Record<string, unknown>;

  scope.window = scope;
  scope.document = {
    createElement: () => ({
      getContext: () => null,
    }),
  };
}

async function loadBasicPitchModule() {
  if (!basicPitchModule) {
    installWorkerBrowserShim();
    basicPitchModule = await import('@spotify/basic-pitch');
  }

  return basicPitchModule;
}

function postFailure(message: string) {
  self.postMessage({
    type: 'error',
    message,
  });
}

self.addEventListener('error', event => {
  event.preventDefault();
  postFailure(event.message || 'Basic Pitch worker failed.');
});

self.addEventListener('unhandledrejection', event => {
  event.preventDefault();
  const reason = event.reason;
  postFailure(reason instanceof Error ? reason.message : 'Basic Pitch worker promise failed.');
});

self.onmessage = async (event: MessageEvent<TranscribeMessage>) => {
  if (event.data.type !== 'transcribe') {
    return;
  }

  try {
    const {
      addPitchBendsToNoteEvents,
      BasicPitch,
      noteFramesToTime,
      outputToNotesPoly,
    } = await loadBasicPitchModule();

    if (!basicPitch || activeModelUrl !== event.data.modelUrl) {
      basicPitch = new BasicPitch(event.data.modelUrl);
      activeModelUrl = event.data.modelUrl;
    }

    const frames: number[][] = [];
    const onsets: number[][] = [];
    const contours: number[][] = [];

    await basicPitch.evaluateModel(
      event.data.samples,
      (frameChunk: number[][], onsetChunk: number[][], contourChunk: number[][]) => {
        frames.push(...frameChunk);
        onsets.push(...onsetChunk);
        contours.push(...contourChunk);
      },
      (progress: number) => {
        self.postMessage({ type: 'progress', progress });
      },
    );

    const notes = noteFramesToTime(
      addPitchBendsToNoteEvents(
        contours,
        outputToNotesPoly(frames, onsets, 0.25, 0.25, 5, true, null, null, false),
      ),
    ).map((note: NoteEventTime) => ({
      startTimeSeconds: note.startTimeSeconds,
      durationSeconds: note.durationSeconds,
      pitchMidi: note.pitchMidi,
      amplitude: note.amplitude,
    }));

    self.postMessage({ type: 'complete', notes });
  } catch (error) {
    self.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : 'Basic Pitch transcription failed.',
    });
  }
};
