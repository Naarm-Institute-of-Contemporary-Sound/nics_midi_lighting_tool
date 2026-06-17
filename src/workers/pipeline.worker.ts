import { Midi } from '@tonejs/midi';
import lightingNotesJson from '../config/lightingNotes.json';
import {
  AUTOMATION_CC_BY_LANE,
  buildAutomationInitialControlChanges,
  buildExportControlChanges,
  clampMidiControl,
  EXPORT_CHANNEL_PRESSURE,
  EXPORT_PITCH_BEND,
} from '../lib/lightingControls';
import type {
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

let source: SourceMidiData | null = null;
let rules: MappingRule[] = createDefaultRules(null);
let confidenceFloor = 0;
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
    source = parseMidiArrayBuffer(message.fileName, message.arrayBuffer);
    confidenceFloor = 0;
    rules = createDefaultRules(source);
    postResponse({ type: 'ready', viewModel: buildViewModel() });
    return;
  }

  if (message.type === 'load-basic-pitch') {
    source = notesFromBasicPitch(message.fileName, message.notes);
    confidenceFloor = DEFAULT_AUDIO_CONFIDENCE_FLOOR;
    rules = createDefaultRules(filterSourceByConfidence(source, confidenceFloor) ?? source);
    postResponse({ type: 'ready', viewModel: buildViewModel() });
    return;
  }

  if (message.type === 'set-confidence-floor') {
    confidenceFloor = clamp01(message.value);
    const filteredSource = filterSourceByConfidence(source, confidenceFloor);
    rules = clampRulesToSource(rules, filteredSource ?? source);
    postResponse({ type: 'updated', viewModel: buildViewModel() });
    return;
  }

  if (message.type === 'set-rules') {
    rules = clampRulesToSource(message.rules, filterSourceByConfidence(source, confidenceFloor) ?? source);
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
    tracks.push({
      id: trackId,
      name: trackName,
      index: trackIndex,
      noteCount: trackNotes.length,
      minMidi: Math.min(...trackNotes.map(note => note.midi)),
      maxMidi: Math.max(...trackNotes.map(note => note.midi)),
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

  const track: SourceTrack = {
    id: 'basic-pitch',
    name: 'Basic Pitch',
    index: null,
    noteCount: notes.length,
    minMidi: Math.min(...notes.map(note => note.midi)),
    maxMidi: Math.max(...notes.map(note => note.midi)),
  };

  return buildSourceData(fileName, 'audio', notes, [track]);
}

function buildSourceData(
  fileName: string,
  sourceType: SourceMidiData['sourceType'],
  notes: SourceNote[],
  tracks: SourceTrack[],
): SourceMidiData {
  return {
    fileName,
    sourceType,
    duration: Math.max(...notes.map(note => note.time + note.duration)),
    notes,
    tracks,
    minMidi: Math.min(...notes.map(note => note.midi)),
    maxMidi: Math.max(...notes.map(note => note.midi)),
  };
}

function buildViewModel(): PipelineViewModel {
  const filteredSource = filterSourceByConfidence(source, confidenceFloor);
  const safeSource = filteredSource ?? source;
  remappedEvents = safeSource?.notes.length ? remapNotes(safeSource, rules) : [];

  return {
    sourceSummary: buildSourceSummary(source, safeSource),
    rules,
    confidenceFloor,
    filteredNoteCount: safeSource?.notes.length ?? 0,
    remappedEventCount: remappedEvents.length,
    eventsByGroup: buildGroupCounts(remappedEvents),
    eventsByTargetNote: buildTargetNoteCounts(remappedEvents),
    histogram: buildHistogram(safeSource),
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
      noteEvents.forEach(event => {
        const start = event.time;
        const end = event.time + event.duration;
        const previous = merged[merged.length - 1];
        if (previous && start <= previous[1]) {
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

function filterSourceByConfidence(
  nextSource: SourceMidiData | null,
  floor: number,
): SourceMidiData | null {
  if (!nextSource || nextSource.sourceType !== 'audio' || floor <= 0) {
    return nextSource;
  }

  const notes = nextSource.notes.filter(note => note.velocity >= floor);
  if (notes.length === nextSource.notes.length) {
    return nextSource;
  }

  return {
    ...nextSource,
    notes,
    minMidi: notes.length ? Math.min(...notes.map(note => note.midi)) : nextSource.minMidi,
    maxMidi: notes.length ? Math.max(...notes.map(note => note.midi)) : nextSource.maxMidi,
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

  const track = midi.addTrack();
  track.name = 'NICS Lighting Triggers';
  track.channel = 0;
  addLightingControlDefaults(track, controls, automation);
  addTimelineAutomation(track, automation);

  events.forEach(event => {
    track.addNote({
      midi: event.targetMidi,
      time: event.time,
      duration: Math.max(0.01, event.duration),
      velocity: clamp01(event.velocity),
    });
  });

  const bytes = injectChannelPressure(midi.toArray(), clampMidi(EXPORT_CHANNEL_PRESSURE));
  const arrayBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(arrayBuffer).set(bytes);

  return {
    bytes: arrayBuffer,
    fileName: `${stripExtension(nextSource.fileName)}.nics-lighting.mid`,
    eventCount: events.length,
  };
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
    value: EXPORT_PITCH_BEND,
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

function injectChannelPressure(bytes: Uint8Array, value: number): Uint8Array {
  const nextBytes = Array.from(bytes);
  const trackHeaderIndex = findNthTrackHeader(nextBytes, 2);
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
  const eventBytes = [0x00, 0xd0, clampMidi(value)];
  const nextLength = currentLength + eventBytes.length;

  nextBytes[lengthIndex] = (nextLength >>> 24) & 0xff;
  nextBytes[lengthIndex + 1] = (nextLength >>> 16) & 0xff;
  nextBytes[lengthIndex + 2] = (nextLength >>> 8) & 0xff;
  nextBytes[lengthIndex + 3] = nextLength & 0xff;
  nextBytes.splice(dataIndex, 0, ...eventBytes);

  return new Uint8Array(nextBytes);
}

function findNthTrackHeader(bytes: number[], occurrence: number): number {
  let found = 0;
  for (let index = 0; index <= bytes.length - 4; index += 1) {
    if (
      bytes[index] === 0x4d &&
      bytes[index + 1] === 0x54 &&
      bytes[index + 2] === 0x72 &&
      bytes[index + 3] === 0x6b
    ) {
      found += 1;
      if (found === occurrence) {
        return index;
      }
    }
  }

  return -1;
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

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function postResponse(response: PipelineResponse, transfer?: Transferable[]) {
  (
    self as unknown as {
      postMessage: (message: PipelineResponse, transfer?: Transferable[]) => void;
    }
  ).postMessage(response, transfer ?? []);
}
