import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  addPitchBendsToNoteEvents,
  BasicPitch,
  noteFramesToTime,
  outputToNotesPoly,
} from '@spotify/basic-pitch';

const inputPath = process.argv[2];
const limitSeconds = Number(process.argv[3] ?? 0);

if (!inputPath) {
  console.error('Usage: node scripts/test-basic-pitch-file.mjs <audio-file> [seconds]');
  process.exit(1);
}

const modelRoot = path.resolve('public', 'basic-pitch-model');
const lightingConfig = JSON.parse(
  readFileSync(path.resolve('src', 'config', 'lightingNotes.json'), 'utf8'),
);

const server = createServer((request, response) => {
  const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
  const fileName = path.basename(requestUrl.pathname);
  const filePath = path.join(modelRoot, fileName);

  try {
    const body = readFileSync(filePath);
    response.writeHead(200, {
      'content-type': fileName.endsWith('.json') ? 'application/json' : 'application/octet-stream',
    });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end('not found');
  }
});

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const modelUrl = `http://127.0.0.1:${port}/model.json`;

  const ffmpegArgs = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    inputPath,
    '-map',
    '0:a:0',
    '-ac',
    '1',
    '-ar',
    '22050',
  ];

  if (Number.isFinite(limitSeconds) && limitSeconds > 0) {
    ffmpegArgs.push('-t', String(limitSeconds));
  }

  ffmpegArgs.push('-f', 'f32le', 'pipe:1');

  const decoded = spawnSync('ffmpeg', ffmpegArgs, {
    encoding: 'buffer',
    maxBuffer: 512 * 1024 * 1024,
  });

  if (decoded.status !== 0) {
    throw new Error(decoded.stderr.toString() || 'ffmpeg decode failed');
  }

  const raw = decoded.stdout;
  const sampleView = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const samples = new Float32Array(sampleView);
  const decodedSeconds = samples.length / 22050;

  const basicPitch = new BasicPitch(modelUrl);
  const frames = [];
  const onsets = [];
  const contours = [];
  let lastLoggedPercent = -1;

  await basicPitch.evaluateModel(
    samples,
    (frameChunk, onsetChunk, contourChunk) => {
      frames.push(...frameChunk);
      onsets.push(...onsetChunk);
      contours.push(...contourChunk);
    },
    progress => {
      const percent = Math.floor(progress * 100);
      if (percent >= lastLoggedPercent + 10 || percent === 100) {
        lastLoggedPercent = percent;
        console.error(`Basic Pitch ${percent}%`);
      }
    },
  );

  const notes = noteFramesToTime(
    addPitchBendsToNoteEvents(
      contours,
      outputToNotesPoly(frames, onsets, 0.25, 0.25, 5, true, null, null, false),
    ),
  );

  const midiNotes = notes.map(note => Math.round(note.pitchMidi));
  const sourceMin = Math.min(...midiNotes);
  const sourceMax = Math.max(...midiNotes);
  const rules = createDefaultRules(sourceMin, sourceMax, lightingConfig);
  const targetCounts = Object.fromEntries(
    lightingConfig.groups.flatMap(group => group.notes.map(note => [note, 0])),
  );

  notes.forEach(note => {
    const sourceMidi = Math.round(note.pitchMidi);
    rules.forEach(rule => {
      const group = lightingConfig.groups.find(candidate => candidate.id === rule.groupId);
      if (!group || sourceMidi < rule.sourceMin || sourceMidi > rule.sourceMax) {
        return;
      }

      const targetMidi = quantizeIntoGroup(sourceMidi, rule.sourceMin, rule.sourceMax, group.notes);
      targetCounts[targetMidi] += 1;
    });
  });

  const summary = {
    inputPath,
    decodedSeconds: Number(decodedSeconds.toFixed(2)),
    sampleCount: samples.length,
    detectedNoteCount: notes.length,
    detectedPitchRange: notes.length ? [sourceMin, sourceMax] : null,
    targetLayout: lightingConfig.groups.map(group => ({
      id: group.id,
      label: group.label,
      noteRange: group.noteRange,
      notes: group.notes,
    })),
    remappedTargetNoteCounts: targetCounts,
    testedFullFile: !(Number.isFinite(limitSeconds) && limitSeconds > 0),
  };

  console.log(JSON.stringify(summary, null, 2));
} finally {
  server.close();
}

function createDefaultRules(minMidi, maxMidi, config) {
  const groupMap = new Map(config.groups.map(group => [group.id, group]));
  const orderedGroups = config.uiGroupOrder.map(groupId => groupMap.get(groupId)).filter(Boolean);
  const totalWeight = orderedGroups.reduce((total, group) => total + group.notes.length, 0);
  const sourceSpan = Math.max(1, maxMidi - minMidi + 1);
  let runningWeight = 0;

  return orderedGroups.map((group, index) => {
    const startRatio = runningWeight / totalWeight;
    runningWeight += group.notes.length;
    const endRatio = runningWeight / totalWeight;
    const sourceMin = minMidi + Math.floor(startRatio * sourceSpan);
    const computedMax = minMidi + Math.floor(endRatio * sourceSpan) - 1;
    const sourceMax = index === orderedGroups.length - 1 ? maxMidi : Math.max(sourceMin, computedMax);

    return {
      groupId: group.id,
      sourceMin: clampMidi(sourceMin),
      sourceMax: clampMidi(Math.min(maxMidi, sourceMax)),
    };
  });
}

function quantizeIntoGroup(sourceMidi, sourceMin, sourceMax, targetNotes) {
  if (targetNotes.length === 1 || sourceMax <= sourceMin) {
    return targetNotes[0];
  }

  const ratio = (sourceMidi - sourceMin) / (sourceMax - sourceMin);
  const targetIndex = Math.round(clamp01(ratio) * (targetNotes.length - 1));
  return targetNotes[targetIndex];
}

function clampMidi(value) {
  return Math.max(0, Math.min(127, value));
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}
