import { Midi } from '@tonejs/midi';
import lightingNotesJson from '../config/lightingNotes.json';
import {
  AUTOMATION_CC_BY_LANE,
  buildAutomationInitialControlChanges,
  buildExportControlChanges,
  clampMidiControl,
  EXPORT_CHANNEL_PRESSURE_CHANNEL,
  EXPORT_PITCH_BEND_CHANNEL,
} from '../lib/lightingControls';
import type {
  AudioCleanupControls,
  AudioFeatureDiagnostics,
  AudioFeatureGroupId,
  AudioFeatureSettings,
  AutomationLaneId,
  BasicPitchNote,
  AutomationBlock,
  ExportMidiControls,
  LightingConfig,
  LightingGroup,
  MappingRule,
  PipelineRequest,
  PipelineResponse,
  PipelineViewModel,
  PianoRollEvent,
  RemapEvent,
  SourceMidiData,
  SourceNote,
  SourceSummary,
  SourceTrack,
  TimelineBin,
  TimelineAutomation,
} from '../types';

const lightingConfig = lightingNotesJson as LightingConfig;
const DEFAULT_AUDIO_CONFIDENCE_FLOOR = 0.18;
const DEFAULT_SOURCE_MIN = 36;
const DEFAULT_SOURCE_MAX = 84;
const HISTOGRAM_BIN_COUNT = 18;
const TIMELINE_MIN_BIN_COUNT = 360;
const TIMELINE_MAX_BIN_COUNT = 3600;
const TIMELINE_SECONDS_PER_BIN = 0.06;
const TIMELINE_WINDOW_JOIN_SECONDS = 0.035;
const DEFAULT_AUDIO_CLEANUP_CONTROLS: AudioCleanupControls = {
  confidenceFloor: DEFAULT_AUDIO_CONFIDENCE_FLOOR,
  mergeGapSeconds: 0.02,
  minDurationSeconds: 0.03,
  pitchMax: 127,
  pitchMin: 0,
};
const DEFAULT_AUDIO_FEATURE_SETTINGS: AudioFeatureSettings = {
  bassWeight: 0.75,
  density: 0.62,
  groupDensities: {
    bigMovingHeads: 0.35,
    parcans: 0.48,
    pixelBars: 0.82,
    smallMovingHeads: 0.42,
    strobe: 0.16,
  },
  maxNoteLengthSeconds: 0.26,
  minEventSpacingSeconds: 0.08,
  minNoteLengthSeconds: 0.045,
  onsetThreshold: 0.52,
  sensitivity: 0.58,
};
const AUDIO_FEATURE_TRACK_ID = 'audio-features';
const AUDIO_FEATURE_WINDOW_SECONDS = 0.046;
const AUDIO_FEATURE_HOP_SECONDS = 0.02;

let source: SourceMidiData | null = null;
let rules: MappingRule[] = createDefaultRules(null);
let audioCleanupControls: AudioCleanupControls = {
  ...DEFAULT_AUDIO_CLEANUP_CONTROLS,
  confidenceFloor: 0,
};
let audioFeatureDiagnostics: AudioFeatureDiagnostics | null = null;
let audioFeatureInput: {
  duration: number;
  fileName: string;
  sampleRate: number;
  samples: Float32Array;
} | null = null;
let audioFeatureSettings = DEFAULT_AUDIO_FEATURE_SETTINGS;
let remappedEvents: RemapEvent[] = [];

self.onmessage = (event: MessageEvent<PipelineRequest>) => {
  try {
    handleRequest(event.data);
  } catch (error) {
    postResponse({
      type: 'error',
      message: error instanceof Error ? error.message : 'Pipeline worker failed.',
    });
  }
};

function handleRequest(message: PipelineRequest) {
  if (message.type === 'load-midi') {
    audioFeatureDiagnostics = null;
    audioFeatureInput = null;
    source = parseMidiArrayBuffer(message.fileName, message.arrayBuffer);
    audioCleanupControls = {
      ...DEFAULT_AUDIO_CLEANUP_CONTROLS,
      confidenceFloor: 0,
    };
    rules = createDefaultRules(source);
    postResponse({ type: 'ready', viewModel: buildViewModel() });
    return;
  }

  if (message.type === 'load-basic-pitch') {
    audioFeatureDiagnostics = null;
    audioFeatureInput = null;
    source = notesFromBasicPitch(message.fileName, message.notes);
    audioCleanupControls = {
      ...DEFAULT_AUDIO_CLEANUP_CONTROLS,
    };
    rules = createDefaultRules(processSourceForAudio(source, audioCleanupControls) ?? source);
    postResponse({ type: 'ready', viewModel: buildViewModel() });
    return;
  }

  if (message.type === 'load-audio-features') {
    audioFeatureInput = {
      duration: message.duration,
      fileName: message.fileName,
      sampleRate: message.sampleRate,
      samples: message.samples,
    };
    audioFeatureSettings = normalizeAudioFeatureSettings(message.settings);
    source = sourceFromAudioFeatures(
      message.fileName,
      message.samples,
      message.sampleRate,
      message.duration,
      audioFeatureSettings,
    );
    audioCleanupControls = {
      ...DEFAULT_AUDIO_CLEANUP_CONTROLS,
      confidenceFloor: 0,
    };
    rules = createFixtureIdentityRules();
    postResponse({ type: 'ready', viewModel: buildViewModel() });
    return;
  }

  if (message.type === 'set-audio-feature-settings') {
    audioFeatureSettings = normalizeAudioFeatureSettings(message.settings);
    if (!audioFeatureInput) {
      postResponse({ type: 'updated', viewModel: buildViewModel() });
      return;
    }

    source = sourceFromAudioFeatures(
      audioFeatureInput.fileName,
      audioFeatureInput.samples,
      audioFeatureInput.sampleRate,
      audioFeatureInput.duration,
      audioFeatureSettings,
    );
    rules = createFixtureIdentityRules();
    postResponse({ type: 'updated', viewModel: buildViewModel() });
    return;
  }

  if (message.type === 'set-audio-cleanup') {
    audioCleanupControls = normalizeAudioCleanupControls(message.controls);
    const filteredSource = processSourceForAudio(source, audioCleanupControls);
    rules = clampRulesToSource(rules, filteredSource ?? source);
    postResponse({ type: 'updated', viewModel: buildViewModel() });
    return;
  }

  if (message.type === 'set-confidence-floor') {
    audioCleanupControls = normalizeAudioCleanupControls({
      ...audioCleanupControls,
      confidenceFloor: message.value,
    });
    const filteredSource = processSourceForAudio(source, audioCleanupControls);
    rules = clampRulesToSource(rules, filteredSource ?? source);
    postResponse({ type: 'updated', viewModel: buildViewModel() });
    return;
  }

  if (message.type === 'set-rules') {
    rules = clampRulesToSource(message.rules, processSourceForAudio(source, audioCleanupControls) ?? source);
    postResponse({ type: 'updated', viewModel: buildViewModel() });
    return;
  }

  if (message.type === 'export-midi') {
    if (!source || remappedEvents.length === 0) {
      throw new Error('No mapped notes to export.');
    }

    const { bytes, fileName, eventCount } = createMidiExportBytes(
      source,
      remappedEvents,
      message.controls,
      message.automation,
    );
    postResponse({ type: 'export-ready', fileName, bytes, eventCount }, [bytes]);
  }
}

function parseMidiArrayBuffer(fileName: string, arrayBuffer: ArrayBuffer): SourceMidiData {
  const midi = new Midi(arrayBuffer);
  const notes: SourceNote[] = [];
  const tracks: SourceTrack[] = [];

  midi.tracks.forEach((track, trackIndex) => {
    if (track.notes.length === 0) {
      return;
    }

    const trackId = `track-${trackIndex}`;
    const trackName = track.name || `Track ${trackIndex + 1}`;
    const trackNotes = track.notes.map((note, noteIndex) => ({
      id: `${trackId}-note-${noteIndex}`,
      trackId,
      trackName,
      midi: clampMidi(Math.round(note.midi)),
      time: Math.max(0, note.time),
      duration: Math.max(0.01, note.duration),
      velocity: clamp01(note.velocity || 0.9),
    }));

    notes.push(...trackNotes);
    const trackStats = getSourceNoteStats(trackNotes);
    tracks.push({
      id: trackId,
      name: trackName,
      index: trackIndex,
      noteCount: trackNotes.length,
      minMidi: trackStats.minMidi,
      maxMidi: trackStats.maxMidi,
    });
  });

  if (notes.length === 0) {
    throw new Error('No MIDI notes were found in this file.');
  }

  return buildSourceData(fileName, 'midi', notes, tracks);
}

function notesFromBasicPitch(fileName: string, basicPitchNotes: BasicPitchNote[]): SourceMidiData {
  const notes = basicPitchNotes.map((note, index) => ({
    id: `basic-pitch-note-${index}`,
    trackId: 'basic-pitch',
    trackName: 'Basic Pitch',
    midi: clampMidi(Math.round(note.pitchMidi)),
    time: Math.max(0, note.startTimeSeconds),
    duration: Math.max(0.03, note.durationSeconds),
    velocity: clamp01(note.amplitude || 0.8),
  }));

  if (notes.length === 0) {
    throw new Error('Basic Pitch did not detect any MIDI notes.');
  }

  const noteStats = getSourceNoteStats(notes);
  const track: SourceTrack = {
    id: 'basic-pitch',
    name: 'Basic Pitch',
    index: null,
    noteCount: notes.length,
    minMidi: noteStats.minMidi,
    maxMidi: noteStats.maxMidi,
  };

  return {
    ...buildSourceData(fileName, 'audio', notes, [track]),
    analysisMode: 'basic-pitch',
  };
}

function sourceFromAudioFeatures(
  fileName: string,
  samples: Float32Array,
  sampleRate: number,
  duration: number,
  settings: AudioFeatureSettings,
): SourceMidiData {
  const normalizedSettings = normalizeAudioFeatureSettings(settings);
  const frames = buildAudioFeatureFrames(samples, sampleRate);
  const notes = generateAudioFeatureNotes(frames, normalizedSettings);
  if (notes.length === 0) {
    throw new Error('Audio feature analysis did not generate any lighting notes.');
  }

  const track: SourceTrack = {
    id: AUDIO_FEATURE_TRACK_ID,
    index: null,
    maxMidi: 17,
    minMidi: 0,
    name: 'Audio Features',
    noteCount: notes.length,
  };
  audioFeatureDiagnostics = {
    bassActivity: calculateAverage(frames.map(frame => frame.bass)),
    eventsByGroup: countSourceNotesByGroup(notes),
    onsetCount: frames.filter(frame => frame.onset > normalizedSettings.onsetThreshold).length,
    totalEvents: notes.length,
  };

  return {
    ...buildSourceData(fileName, 'audio', notes, [track]),
    analysisMode: 'audio-features',
    duration: Math.max(duration, getSourceNoteStats(notes).duration),
    maxMidi: 17,
    minMidi: 0,
  };
}

type AudioFeatureFrame = {
  bass: number;
  high: number;
  loudness: number;
  onset: number;
  section: number;
  time: number;
};

function buildAudioFeatureFrames(samples: Float32Array, sampleRate: number): AudioFeatureFrame[] {
  const safeSampleRate = Math.max(1, sampleRate);
  const windowSize = Math.max(128, Math.round(AUDIO_FEATURE_WINDOW_SECONDS * safeSampleRate));
  const hopSize = Math.max(64, Math.round(AUDIO_FEATURE_HOP_SECONDS * safeSampleRate));
  const rawFrames: Array<Omit<AudioFeatureFrame, 'section'> & { rawEnergy: number }> = [];
  let previousBass = 0;
  let previousHigh = 0;
  let previousLoudness = 0;

  for (let start = 0; start < samples.length; start += hopSize) {
    const end = Math.min(samples.length, start + windowSize);
    let bassState = previousBass;
    let bassSum = 0;
    let highSum = 0;
    let totalSum = 0;

    for (let index = start; index < end; index += 1) {
      const sample = samples[index] || 0;
      bassState += 0.035 * (sample - bassState);
      const high = sample - bassState;
      bassSum += bassState * bassState;
      highSum += high * high;
      totalSum += sample * sample;
    }

    const count = Math.max(1, end - start);
    const bass = Math.sqrt(bassSum / count);
    const high = Math.sqrt(highSum / count);
    const loudness = Math.sqrt(totalSum / count);
    const rawOnset =
      Math.max(0, bass - previousBass) * 0.9 +
      Math.max(0, high - previousHigh) * 1.15 +
      Math.max(0, loudness - previousLoudness) * 0.75;

    rawFrames.push({
      bass,
      high,
      loudness,
      onset: rawOnset,
      rawEnergy: loudness + bass * 0.55 + high * 0.25,
      time: start / safeSampleRate,
    });

    previousBass = bass;
    previousHigh = high;
    previousLoudness = loudness;
  }

  const bassScale = percentile(rawFrames.map(frame => frame.bass), 0.94) || 1;
  const highScale = percentile(rawFrames.map(frame => frame.high), 0.94) || 1;
  const loudnessScale = percentile(rawFrames.map(frame => frame.loudness), 0.94) || 1;
  const onsetScale = percentile(rawFrames.map(frame => frame.onset), 0.96) || 1;
  const normalized = rawFrames.map(frame => ({
    bass: clamp01(frame.bass / bassScale),
    high: clamp01(frame.high / highScale),
    loudness: clamp01(frame.loudness / loudnessScale),
    onset: clamp01(frame.onset / onsetScale),
    section: 0,
    time: frame.time,
  }));
  const smoothRadius = Math.max(1, Math.round(1.2 / AUDIO_FEATURE_HOP_SECONDS));

  return normalized.map((frame, index) => {
    let total = 0;
    let count = 0;
    const start = Math.max(0, index - smoothRadius);
    const end = Math.min(normalized.length - 1, index + smoothRadius);
    for (let cursor = start; cursor <= end; cursor += 1) {
      const candidate = normalized[cursor];
      total += candidate.loudness * 0.55 + candidate.bass * 0.35 + candidate.high * 0.1;
      count += 1;
    }
    return {
      ...frame,
      section: clamp01(total / Math.max(1, count)),
    };
  });
}

function generateAudioFeatureNotes(
  frames: AudioFeatureFrame[],
  settings: AudioFeatureSettings,
): SourceNote[] {
  const groups = new Map(lightingConfig.groups.map(group => [group.id, group]));
  const notes: SourceNote[] = [];
  const lastEventByGroup: Partial<Record<AudioFeatureGroupId, number>> = {};
  const counters: Partial<Record<AudioFeatureGroupId, number>> = {};
  const baseThreshold = 0.78 - settings.sensitivity * 0.38;
  const densitySpacing = settings.minEventSpacingSeconds / Math.max(0.25, settings.density);

  const addEvent = (
    groupId: AudioFeatureGroupId,
    frame: AudioFeatureFrame,
    strength: number,
    threshold: number,
    spacingMultiplier: number,
    durationMultiplier = 1,
  ) => {
    const group = groups.get(groupId);
    if (!group || strength < threshold) {
      return;
    }

    const groupDensity = settings.groupDensities[groupId] ?? 0.5;
    if (groupDensity <= 0) {
      return;
    }

    const minSpacing = Math.max(0.035, densitySpacing * spacingMultiplier / Math.max(0.2, groupDensity));
    const lastEvent = lastEventByGroup[groupId] ?? -Infinity;
    if (frame.time - lastEvent < minSpacing) {
      return;
    }

    const counter = counters[groupId] ?? 0;
    const targetNotes = group.notes;
    const noteIndex = Math.min(
      targetNotes.length - 1,
      Math.max(0, Math.floor(clamp01(strength) * targetNotes.length + counter) % targetNotes.length),
    );
    const midi = targetNotes[noteIndex];
    const duration = clampSeconds(
      settings.minNoteLengthSeconds + clamp01(strength) * (settings.maxNoteLengthSeconds - settings.minNoteLengthSeconds) * durationMultiplier,
      settings.minNoteLengthSeconds,
      settings.maxNoteLengthSeconds,
    );
    notes.push({
      duration,
      id: `audio-feature-${groupId}-${notes.length}`,
      midi,
      time: frame.time,
      trackId: AUDIO_FEATURE_TRACK_ID,
      trackName: 'Audio Features',
      velocity: clamp01(0.45 + strength * 0.55),
    });
    lastEventByGroup[groupId] = frame.time;
    counters[groupId] = counter + 1;
  };

  frames.forEach(frame => {
    const bassDrive = clamp01(frame.bass * settings.bassWeight + frame.onset * 0.42 + frame.loudness * 0.2);
    const pixelDrive = clamp01(bassDrive * 0.85 + frame.onset * 0.45);
    const smallHeadDrive = clamp01(frame.high * 0.65 + frame.onset * 0.45 + frame.loudness * 0.12);
    const parcanDrive = clamp01(frame.section * 0.62 + frame.bass * 0.25 + frame.loudness * 0.24);
    const bigHeadDrive = clamp01(frame.section * 0.82 + frame.onset * 0.22);

    addEvent('pixelBars', frame, pixelDrive, baseThreshold - 0.14, 0.72);
    addEvent('parcans', frame, parcanDrive, baseThreshold - 0.02, 1.45, 1.25);
    addEvent('smallMovingHeads', frame, smallHeadDrive, baseThreshold + 0.06, 1.85, 1.2);
    addEvent('bigMovingHeads', frame, bigHeadDrive, baseThreshold + 0.18, 7.5, 1.9);
    addEvent('strobe', frame, frame.onset, Math.max(0.72, settings.onsetThreshold + 0.16), 12, 0.65);
  });

  return notes.sort((a, b) => a.time - b.time || a.midi - b.midi);
}

function buildSourceData(
  fileName: string,
  sourceType: SourceMidiData['sourceType'],
  notes: SourceNote[],
  tracks: SourceTrack[],
): SourceMidiData {
  const noteStats = getSourceNoteStats(notes);
  return {
    fileName,
    sourceType,
    duration: noteStats.duration,
    notes,
    tracks,
    minMidi: noteStats.minMidi,
    maxMidi: noteStats.maxMidi,
  };
}

function getSourceNoteStats(notes: SourceNote[]) {
  return notes.reduce(
    (stats, note) => ({
      duration: Math.max(stats.duration, note.time + note.duration),
      maxMidi: Math.max(stats.maxMidi, note.midi),
      minMidi: Math.min(stats.minMidi, note.midi),
    }),
    {
      duration: 0,
      maxMidi: 0,
      minMidi: 127,
    },
  );
}

function buildViewModel(): PipelineViewModel {
  const filteredSource = processSourceForAudio(source, audioCleanupControls);
  const safeSource = filteredSource ?? source;
  remappedEvents = safeSource?.notes.length ? remapNotes(safeSource, rules) : [];

  return {
    sourceSummary: buildSourceSummary(source, safeSource),
    rules,
    audioCleanup: audioCleanupControls,
    audioFeatureDiagnostics,
    audioFeatureSettings,
    confidenceFloor: audioCleanupControls.confidenceFloor,
    filteredNoteCount: safeSource?.notes.length ?? 0,
    remappedEventCount: remappedEvents.length,
    eventsByGroup: buildGroupCounts(remappedEvents),
    eventsByTargetNote: buildTargetNoteCounts(remappedEvents),
    histogram: buildHistogram(safeSource),
    pianoRollByGroup: buildPianoRollByGroup(remappedEvents),
    timelineBinsByTargetNote: buildTimelineBins(remappedEvents, safeSource?.duration ?? 0.01),
    activeWindowsByTargetNote: buildActiveWindows(remappedEvents),
  };
}

function buildSourceSummary(
  originalSource: SourceMidiData | null,
  filteredSource: SourceMidiData | null,
): SourceSummary | null {
  if (!originalSource) {
    return null;
  }

  return {
    fileName: originalSource.fileName,
    sourceType: originalSource.sourceType,
    analysisMode: originalSource.analysisMode,
    duration: originalSource.duration,
    totalNoteCount: originalSource.notes.length,
    filteredNoteCount: filteredSource?.notes.length ?? 0,
    minMidi: originalSource.minMidi,
    maxMidi: originalSource.maxMidi,
    filteredMinMidi: filteredSource?.minMidi ?? originalSource.minMidi,
    filteredMaxMidi: filteredSource?.maxMidi ?? originalSource.maxMidi,
    tracks: originalSource.tracks,
  };
}

function createDefaultRules(nextSource: SourceMidiData | null): MappingRule[] {
  const minMidi = nextSource?.minMidi ?? DEFAULT_SOURCE_MIN;
  const maxMidi = nextSource?.maxMidi ?? DEFAULT_SOURCE_MAX;
  const groupMap = new Map(lightingConfig.groups.map(group => [group.id, group]));
  const orderedGroups = lightingConfig.uiGroupOrder
    .map(groupId => groupMap.get(groupId))
    .filter((group): group is LightingGroup => Boolean(group));
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
      enabled: true,
      allowOverlap: true,
      sourceTrackId: 'all',
      sourceMin: clampMidi(sourceMin),
      sourceMax: clampMidi(Math.min(maxMidi, sourceMax)),
    };
  });
}

function createFixtureIdentityRules(): MappingRule[] {
  return lightingConfig.uiGroupOrder
    .map(groupId => lightingConfig.groups.find(group => group.id === groupId))
    .filter((group): group is LightingGroup => Boolean(group))
    .map(group => ({
      allowOverlap: true,
      enabled: true,
      groupId: group.id,
      sourceMax: group.noteRange[1],
      sourceMin: group.noteRange[0],
      sourceTrackId: 'all',
    }));
}

function normalizeAudioFeatureSettings(settings: AudioFeatureSettings): AudioFeatureSettings {
  const defaults = DEFAULT_AUDIO_FEATURE_SETTINGS;
  const groupDensities = Object.entries(defaults.groupDensities).reduce(
    (record, [groupId, defaultValue]) => ({
      ...record,
      [groupId]: clamp01(settings.groupDensities?.[groupId as AudioFeatureGroupId] ?? defaultValue),
    }),
    {} as Record<AudioFeatureGroupId, number>,
  );
  const minNoteLengthSeconds = clampSeconds(
    settings.minNoteLengthSeconds ?? defaults.minNoteLengthSeconds,
    0.015,
    0.5,
  );
  const maxNoteLengthSeconds = clampSeconds(
    settings.maxNoteLengthSeconds ?? defaults.maxNoteLengthSeconds,
    minNoteLengthSeconds,
    1.5,
  );

  return {
    bassWeight: clamp01(settings.bassWeight ?? defaults.bassWeight),
    density: clamp01(settings.density ?? defaults.density),
    groupDensities,
    maxNoteLengthSeconds,
    minEventSpacingSeconds: clampSeconds(
      settings.minEventSpacingSeconds ?? defaults.minEventSpacingSeconds,
      0.02,
      1,
    ),
    minNoteLengthSeconds,
    onsetThreshold: clamp01(settings.onsetThreshold ?? defaults.onsetThreshold),
    sensitivity: clamp01(settings.sensitivity ?? defaults.sensitivity),
  };
}

function countSourceNotesByGroup(notes: SourceNote[]): Record<string, number> {
  const counts = lightingConfig.groups.reduce<Record<string, number>>((record, group) => {
    record[group.id] = 0;
    return record;
  }, {});
  notes.forEach(note => {
    const group = lightingConfig.groups.find(candidate => note.midi >= candidate.noteRange[0] && note.midi <= candidate.noteRange[1]);
    if (group) {
      counts[group.id] = (counts[group.id] ?? 0) + 1;
    }
  });
  return counts;
}

function clampRulesToSource(nextRules: MappingRule[], nextSource: SourceMidiData | null): MappingRule[] {
  if (!nextSource) {
    return nextRules;
  }

  return nextRules.map(rule => {
    const sourceMin = clampPitch(rule.sourceMin, nextSource.minMidi, nextSource.maxMidi);
    const sourceMax = clampPitch(rule.sourceMax, nextSource.minMidi, nextSource.maxMidi);

    return {
      ...rule,
      sourceMin: Math.min(sourceMin, sourceMax),
      sourceMax: Math.max(sourceMin, sourceMax),
    };
  });
}

function remapNotes(nextSource: SourceMidiData, nextRules: MappingRule[]): RemapEvent[] {
  const groups = new Map(lightingConfig.groups.map(group => [group.id, group]));
  const events: RemapEvent[] = [];

  nextSource.notes.forEach(note => {
    const matchingRules = nextRules.filter(rule => {
      const group = groups.get(rule.groupId);
      if (!group || !rule.enabled) {
        return false;
      }

      if (rule.sourceTrackId !== 'all' && rule.sourceTrackId !== note.trackId) {
        return false;
      }

      const min = Math.min(rule.sourceMin, rule.sourceMax);
      const max = Math.max(rule.sourceMin, rule.sourceMax);
      return note.midi >= min && note.midi <= max;
    });
    const exclusiveRule = matchingRules.find(rule => !rule.allowOverlap);
    const selectedRules = [
      ...(exclusiveRule ? [exclusiveRule] : []),
      ...matchingRules.filter(rule => rule.allowOverlap),
    ];

    selectedRules.forEach(rule => {
      const group = groups.get(rule.groupId);
      if (!group) {
        return;
      }

      const min = Math.min(rule.sourceMin, rule.sourceMax);
      const max = Math.max(rule.sourceMin, rule.sourceMax);
      events.push({
        ...note,
        id: `${note.id}-${group.id}`,
        groupId: group.id,
        targetMidi: quantizeIntoGroup(note.midi, min, max, group.notes),
      });
    });
  });

  return events.sort((a, b) => a.time - b.time || a.targetMidi - b.targetMidi);
}

function buildGroupCounts(events: RemapEvent[]): Record<string, number> {
  const counts = lightingConfig.groups.reduce<Record<string, number>>((nextCounts, group) => {
    nextCounts[group.id] = 0;
    return nextCounts;
  }, {});

  events.forEach(event => {
    counts[event.groupId] = (counts[event.groupId] ?? 0) + 1;
  });

  return counts;
}

function buildTargetNoteCounts(events: RemapEvent[]): Record<number, number> {
  const counts = lightingConfig.groups.reduce<Record<number, number>>((nextCounts, group) => {
    group.notes.forEach(note => {
      nextCounts[note] = 0;
    });
    return nextCounts;
  }, {});

  events.forEach(event => {
    counts[event.targetMidi] = (counts[event.targetMidi] ?? 0) + 1;
  });

  return counts;
}

function buildPianoRollByGroup(events: RemapEvent[]): Record<string, PianoRollEvent[]> {
  const groups = lightingConfig.groups.reduce<Record<string, PianoRollEvent[]>>((record, group) => {
    record[group.id] = [];
    return record;
  }, {});

  events.forEach(event => {
    groups[event.groupId]?.push({
      duration: event.duration,
      sourceMidi: event.midi,
      targetMidi: event.targetMidi,
      time: event.time,
      velocity: event.velocity,
    });
  });

  Object.values(groups).forEach(groupEvents => {
    groupEvents.sort((a, b) => a.time - b.time || a.sourceMidi - b.sourceMidi);
  });

  return groups;
}

function buildHistogram(nextSource: SourceMidiData | null): number[] {
  const bins = new Array(HISTOGRAM_BIN_COUNT).fill(0);
  if (!nextSource || nextSource.notes.length === 0) {
    return bins;
  }

  const span = Math.max(1, nextSource.maxMidi - nextSource.minMidi + 1);
  nextSource.notes.forEach(note => {
    const index = Math.min(
      HISTOGRAM_BIN_COUNT - 1,
      Math.floor(((note.midi - nextSource.minMidi) / span) * HISTOGRAM_BIN_COUNT),
    );
    bins[index] += 1;
  });

  const max = Math.max(...bins, 1);
  return bins.map(value => value / max);
}

function buildTimelineBins(events: RemapEvent[], duration: number): Record<number, TimelineBin[]> {
  const safeDuration = Math.max(0.01, duration);
  const binCount = getTimelineBinCount(safeDuration);
  const countsByNote = buildEmptyTargetRecord<number[]>(() => new Array(binCount).fill(0));

  events.forEach(event => {
    const bins = countsByNote[event.targetMidi];
    if (!bins) {
      return;
    }

    const start = Math.max(
      0,
      Math.min(binCount - 1, Math.floor((event.time / safeDuration) * binCount)),
    );
    const end = Math.max(
      start,
      Math.min(
        binCount - 1,
        Math.ceil(((event.time + event.duration) / safeDuration) * binCount),
      ),
    );

    for (let index = start; index <= end; index += 1) {
      bins[index] += 1;
    }
  });

  return Object.entries(countsByNote).reduce<Record<number, TimelineBin[]>>((nextBins, [note, counts]) => {
    nextBins[Number(note)] = counts.reduce<TimelineBin[]>((bins, count, index) => {
      if (count > 0) {
        bins.push({
          startRatio: index / binCount,
          endRatio: (index + 1) / binCount,
          count,
        });
      }
      return bins;
    }, []);
    return nextBins;
  }, {});
}

function getTimelineBinCount(duration: number): number {
  return Math.max(
    TIMELINE_MIN_BIN_COUNT,
    Math.min(TIMELINE_MAX_BIN_COUNT, Math.ceil(duration / TIMELINE_SECONDS_PER_BIN)),
  );
}

function buildActiveWindows(events: RemapEvent[]): Record<number, Array<[number, number]>> {
  const eventsByNote = buildEmptyTargetRecord<RemapEvent[]>(() => []);
  events.forEach(event => {
    eventsByNote[event.targetMidi]?.push(event);
  });

  return Object.entries(eventsByNote).reduce<Record<number, Array<[number, number]>>>(
    (windows, [note, noteEvents]) => {
      const merged: Array<[number, number]> = [];
      const sortedEvents = [...noteEvents].sort((left, right) => left.time - right.time);
      sortedEvents.forEach(event => {
        const start = event.time;
        const end = event.time + event.duration;
        const previous = merged[merged.length - 1];
        if (previous && start <= previous[1] + TIMELINE_WINDOW_JOIN_SECONDS) {
          previous[1] = Math.max(previous[1], end);
        } else {
          merged.push([start, end]);
        }
      });
      windows[Number(note)] = merged;
      return windows;
    },
    {},
  );
}

function buildEmptyTargetRecord<T>(factory: () => T): Record<number, T> {
  return lightingConfig.groups.reduce<Record<number, T>>((record, group) => {
    group.notes.forEach(note => {
      record[note] = factory();
    });
    return record;
  }, {});
}

function processSourceForAudio(
  nextSource: SourceMidiData | null,
  controls: AudioCleanupControls,
): SourceMidiData | null {
  if (!nextSource || nextSource.sourceType !== 'audio' || nextSource.analysisMode === 'audio-features') {
    return nextSource;
  }

  const normalizedControls = normalizeAudioCleanupControls(controls);
  const filteredNotes = nextSource.notes.filter(note => {
    return (
      note.velocity >= normalizedControls.confidenceFloor &&
      note.duration >= normalizedControls.minDurationSeconds &&
      note.midi >= normalizedControls.pitchMin &&
      note.midi <= normalizedControls.pitchMax
    );
  });
  const notes = mergeSamePitchNotes(filteredNotes, normalizedControls.mergeGapSeconds);

  if (
    notes.length === nextSource.notes.length &&
    normalizedControls.confidenceFloor <= 0 &&
    normalizedControls.minDurationSeconds <= 0 &&
    normalizedControls.mergeGapSeconds <= 0 &&
    normalizedControls.pitchMin <= 0 &&
    normalizedControls.pitchMax >= 127
  ) {
    return nextSource;
  }

  const noteStats = notes.length ? getSourceNoteStats(notes) : null;
  return {
    ...nextSource,
    notes,
    duration: nextSource.duration,
    minMidi: noteStats?.minMidi ?? nextSource.minMidi,
    maxMidi: noteStats?.maxMidi ?? nextSource.maxMidi,
  };
}

function mergeSamePitchNotes(notes: SourceNote[], mergeGapSeconds: number): SourceNote[] {
  const mergeGap = clampSeconds(mergeGapSeconds, 0, 1);
  if (mergeGap <= 0 || notes.length <= 1) {
    return [...notes].sort((a, b) => a.time - b.time || a.midi - b.midi);
  }

  const byPitch = notes.reduce<Record<number, SourceNote[]>>((record, note) => {
    (record[note.midi] ??= []).push(note);
    return record;
  }, {});

  return Object.entries(byPitch)
    .flatMap(([pitch, pitchNotes]) => {
      const merged: SourceNote[] = [];
      const sortedPitchNotes = [...pitchNotes].sort((a, b) => a.time - b.time);
      sortedPitchNotes.forEach(note => {
        const previous = merged[merged.length - 1];
        if (previous && note.time <= previous.time + previous.duration + mergeGap) {
          const previousEnd = previous.time + previous.duration;
          const nextEnd = note.time + note.duration;
          previous.duration = Math.max(previousEnd, nextEnd) - previous.time;
          previous.velocity = Math.max(previous.velocity, note.velocity);
          return;
        }

        merged.push({
          ...note,
          midi: clampMidi(Number(pitch)),
        });
      });
      return merged;
    })
    .sort((a, b) => a.time - b.time || a.midi - b.midi);
}

function normalizeAudioCleanupControls(controls: AudioCleanupControls): AudioCleanupControls {
  const pitchMin = clampMidi(controls.pitchMin);
  const pitchMax = clampMidi(controls.pitchMax);
  return {
    confidenceFloor: clamp01(controls.confidenceFloor),
    mergeGapSeconds: clampSeconds(controls.mergeGapSeconds, 0, 1),
    minDurationSeconds: clampSeconds(controls.minDurationSeconds, 0, 1),
    pitchMin: Math.min(pitchMin, pitchMax),
    pitchMax: Math.max(pitchMin, pitchMax),
  };
}

function createMidiExportBytes(
  nextSource: SourceMidiData,
  events: RemapEvent[],
  controls: ExportMidiControls,
  automation: TimelineAutomation,
) {
  const midi = new Midi();
  midi.header.tempos = [];
  midi.header.timeSignatures = [];
  const exportEvents = shapeEventsForPhysicalOutput(
    events,
    controls.noteHoldSeconds,
    controls.noteMergeGapSeconds,
    controls.noteVelocityFloor,
    controls.noteVelocityCeiling,
    controls.fixtureVelocityRanges,
  );

  const track = midi.addTrack();
  track.name = 'NICS Lighting Triggers';
  track.channel = EXPORT_PITCH_BEND_CHANNEL;
  addLightingControlDefaults(track, controls, automation);
  addTimelineAutomation(track, automation);

  exportEvents.forEach(event => {
    track.addNote({
      midi: event.targetMidi,
      time: event.time,
      duration: Math.max(0.01, event.duration),
      velocity: clamp01(event.velocity),
    });
  });
  addEndOfSourceMarker(track, nextSource.duration);

  const bytes = injectChannelPressure(
    midi.toArray(),
    clampMidi(controls.headY),
    EXPORT_CHANNEL_PRESSURE_CHANNEL,
  );
  const arrayBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(arrayBuffer).set(bytes);

  return {
    bytes: arrayBuffer,
    fileName: `${stripExtension(nextSource.fileName)}.nics-lighting.mid`,
    eventCount: exportEvents.length,
  };
}

function shapeEventsForPhysicalOutput(
  events: RemapEvent[],
  holdSeconds: number,
  mergeGapSeconds: number,
  velocityFloor: number,
  velocityCeiling: number,
  fixtureVelocityRanges: ExportMidiControls['fixtureVelocityRanges'] = {},
): RemapEvent[] {
  const hold = clampSeconds(holdSeconds, 0, 1);
  const mergeGap = clampSeconds(mergeGapSeconds, 0, 0.5);
  const floor = clampMidi(Math.min(velocityFloor, velocityCeiling)) / 127;
  const ceiling = clampMidi(Math.max(velocityFloor, velocityCeiling)) / 127;
  const eventsByNote = events.reduce<Record<number, RemapEvent[]>>((groups, event) => {
    (groups[event.targetMidi] ??= []).push(event);
    return groups;
  }, {});

  return Object.values(eventsByNote)
    .flatMap(noteEvents => {
      const sortedEvents = [...noteEvents].sort((a, b) => a.time - b.time);
      const shapedEvents: RemapEvent[] = [];

      sortedEvents.forEach(event => {
        const duration = Math.max(0.01, event.duration, hold);
        const groupRange = fixtureVelocityRanges[event.groupId];
        const groupFloor = groupRange
          ? clampMidi(Math.min(groupRange.floor, groupRange.ceiling)) / 127
          : floor;
        const groupCeiling = groupRange
          ? clampMidi(Math.max(groupRange.floor, groupRange.ceiling)) / 127
          : ceiling;
        const globalVelocity = Math.max(floor, Math.min(ceiling, event.velocity));
        const nextEvent: RemapEvent = {
          ...event,
          duration,
          velocity: clamp01(Math.max(groupFloor, Math.min(groupCeiling, globalVelocity))),
        };
        const previous = shapedEvents[shapedEvents.length - 1];

        if (previous && nextEvent.time <= previous.time + previous.duration + mergeGap) {
          const previousEnd = previous.time + previous.duration;
          const nextEnd = nextEvent.time + nextEvent.duration;
          previous.duration = Math.max(previousEnd, nextEnd) - previous.time;
          previous.velocity = Math.max(previous.velocity, nextEvent.velocity);
          return;
        }

        shapedEvents.push(nextEvent);
      });

      return shapedEvents;
    })
    .sort((a, b) => a.time - b.time || a.targetMidi - b.targetMidi);
}

function addLightingControlDefaults(
  track: ReturnType<Midi['addTrack']>,
  controls: ExportMidiControls,
  automation: TimelineAutomation,
) {
  const controlChanges = {
    ...buildExportControlChanges(controls),
    ...buildAutomationInitialControlChanges(automation),
  };

  Object.entries(controlChanges).forEach(([controller, value]) => {
    track.addCC({
      number: Number(controller),
      ticks: 0,
      value: clampMidiControl(value) / 127,
    });
  });

  track.addPitchBend({
    ticks: 0,
    value: midiControlToPitchBendOffset(controls.headX),
  });
}

function addEndOfSourceMarker(track: ReturnType<Midi['addTrack']>, duration: number) {
  if (!Number.isFinite(duration) || duration <= 0) {
    return;
  }

  track.addCC({
    number: 123,
    time: duration,
    value: 0,
  });
}

function addTimelineAutomation(
  track: ReturnType<Midi['addTrack']>,
  automation: TimelineAutomation,
) {
  Object.entries(AUTOMATION_CC_BY_LANE).forEach(([laneId, controller]) => {
    const blocks = (automation[laneId as AutomationLaneId] ?? [])
      .map(block => normalizeAutomationBlock(block))
      .filter((block): block is AutomationBlock => Boolean(block));

    blocks.forEach(block => {
      if (block.start > 0) {
        track.addCC({
          number: controller,
          time: block.start,
          value: 1,
        });
      }

      track.addCC({
        number: controller,
        time: block.end,
        value: 0,
      });
    });
  });
}

function normalizeAutomationBlock(block: AutomationBlock): AutomationBlock | null {
  const start = Math.max(0, Number.isFinite(block.start) ? block.start : 0);
  const end = Math.max(start, Number.isFinite(block.end) ? block.end : start);
  if (end - start < 0.001) {
    return null;
  }

  return {
    ...block,
    start,
    end,
  };
}

function injectChannelPressure(bytes: Uint8Array, value: number, channel: number): Uint8Array {
  const nextBytes = Array.from(bytes);
  const trackHeaderIndex = findLastTrackHeader(nextBytes);
  if (trackHeaderIndex < 0) {
    return bytes;
  }

  const lengthIndex = trackHeaderIndex + 4;
  const dataIndex = trackHeaderIndex + 8;
  const currentLength =
    (nextBytes[lengthIndex] << 24) |
    (nextBytes[lengthIndex + 1] << 16) |
    (nextBytes[lengthIndex + 2] << 8) |
    nextBytes[lengthIndex + 3];
  const eventBytes = [0x00, 0xd0 + clampMidiChannel(channel), clampMidi(value)];
  const nextLength = currentLength + eventBytes.length;

  nextBytes[lengthIndex] = (nextLength >>> 24) & 0xff;
  nextBytes[lengthIndex + 1] = (nextLength >>> 16) & 0xff;
  nextBytes[lengthIndex + 2] = (nextLength >>> 8) & 0xff;
  nextBytes[lengthIndex + 3] = nextLength & 0xff;
  nextBytes.splice(dataIndex, 0, ...eventBytes);

  return new Uint8Array(nextBytes);
}

function findLastTrackHeader(bytes: number[]): number {
  let lastTrackHeader = -1;
  for (let index = 0; index <= bytes.length - 4; index += 1) {
    if (
      bytes[index] === 0x4d &&
      bytes[index + 1] === 0x54 &&
      bytes[index + 2] === 0x72 &&
      bytes[index + 3] === 0x6b
    ) {
      lastTrackHeader = index;
    }
  }

  return lastTrackHeader;
}

function quantizeIntoGroup(sourceMidi: number, sourceMin: number, sourceMax: number, targetNotes: number[]): number {
  if (targetNotes.length === 1 || sourceMax <= sourceMin) {
    return targetNotes[0];
  }

  const ratio = (sourceMidi - sourceMin) / (sourceMax - sourceMin);
  const targetIndex = Math.round(clamp01(ratio) * (targetNotes.length - 1));
  return targetNotes[targetIndex];
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^/.]+$/, '') || 'nics-lighting-map';
}

function clampPitch(value: number, min: number, max: number): number {
  const safeValue = Number.isFinite(value) ? Math.round(value) : min;
  return Math.max(min, Math.min(max, safeValue));
}

function clampMidi(value: number): number {
  return Math.max(0, Math.min(127, value));
}

function clampMidiChannel(value: number): number {
  const safeValue = Number.isFinite(value) ? Math.round(value) : 0;
  return Math.max(0, Math.min(15, safeValue));
}

function midiControlToPitchBendOffset(value: number): number {
  const ratio = clampMidi(value) / 127;
  return Math.max(-8192, Math.min(8191, Math.round(ratio * 16383 - 8192)));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampSeconds(value: number, min: number, max: number): number {
  const safeValue = Number.isFinite(value) ? value : min;
  return Math.max(min, Math.min(max, safeValue));
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio)));
  return sorted[index] || 0;
}

function calculateAverage(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
}

function postResponse(response: PipelineResponse, transfer?: Transferable[]) {
  (
    self as unknown as {
      postMessage: (message: PipelineResponse, transfer?: Transferable[]) => void;
    }
  ).postMessage(response, transfer ?? []);
}
