import type { BasicPitchNote } from '../types';

type WorkerProgress = {
  type: 'progress';
  progress: number;
};

type WorkerComplete = {
  type: 'complete';
  notes: BasicPitchNote[];
};

type WorkerFailure = {
  type: 'error';
  message: string;
};

type WorkerResponse = WorkerProgress | WorkerComplete | WorkerFailure;

export function transcribeWithBasicPitch(
  samples: Float32Array,
  onProgress: (progress: number) => void,
): Promise<BasicPitchNote[]> {
  const worker = new Worker(new URL('../workers/basicPitch.worker.ts', import.meta.url), {
    type: 'module',
  });
  const modelUrl = new URL(
    `${import.meta.env.BASE_URL}basic-pitch-model/model.json`,
    window.location.href,
  ).href;

  return new Promise((resolve, reject) => {
    let settled = false;

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (event.data.type === 'progress') {
        onProgress(event.data.progress);
        return;
      }

      if (settled) {
        return;
      }

      settled = true;
      worker.terminate();

      if (event.data.type === 'complete') {
        resolve(event.data.notes);
        return;
      }

      reject(new Error(event.data.message));
    };

    worker.onerror = event => {
      if (settled) {
        return;
      }

      settled = true;
      worker.terminate();
      reject(new Error(event.message || 'Basic Pitch worker failed.'));
    };

    worker.onmessageerror = () => {
      if (settled) {
        return;
      }

      settled = true;
      worker.terminate();
      reject(new Error('Basic Pitch worker could not read the audio data message.'));
    };

    worker.postMessage(
      {
        type: 'transcribe',
        modelUrl,
        samples,
      },
      [samples.buffer],
    );
  });
}
