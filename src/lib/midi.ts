import { Midi } from '@tonejs/midi';
import type {
  BasicPitchNote,
  ExportedMidi,
  LightingConfig,
  LightingGroup,
  MappingRule,
  RemapEvent,
  SourceMidiData,
  SourceNote,
  SourceTrack,
} from '../types';

const MIDI_EXTENSIONS = ['.mid', '.midi'];
const DEFAULT_SOURCE_MIN = 36;
const DEFAULT_SOURCE_MAX = 84;

export function isMidiFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return MIDI_EXTENSIONS.some(extension => name.endsWith(extension)) || file.type === 'audio/midi';
}

export async function parseMidiFile(file: File): Promise<SourceMidiData> {
  const midi = new Midi(await file.arrayBuffer());
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

  return buildSourceData(file.name, 'midi', notes, tracks);
}

export function notesFromBasicPitch(fileName: string, basicPitchNotes: BasicPitchNote[]): SourceMidiData {
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

export function createDefaultRules(source: SourceMidiData | null, config: LightingConfig): MappingRule[] {
  const minMidi = source?.minMidi ?? DEFAULT_SOURCE_MIN;
  const maxMidi = source?.maxMidi ?? DEFAULT_SOURCE_MAX;
  const groupMap = new Map(config.groups.map(group => [group.id, group]));
  const orderedGroups = config.uiGroupOrder
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
      allowOverlap: false,
      sourceTrackId: 'all',
      sourceMin: clampMidi(sourceMin),
      sourceMax: clampMidi(Math.min(maxMidi, sourceMax)),
    };
  });
}

export function remapNotes(
  source: SourceMidiData,
  rules: MappingRule[],
  config: LightingConfig,
): RemapEvent[] {
  const groups = new Map(config.groups.map(group => [group.id, group]));
  const events: RemapEvent[] = [];

  source.notes.forEach(note => {
    const matchingRules = rules.filter(rule => {
      const group = groups.get(rule.groupId);
      if (!group || !rule.enabled) {
        return false;
      }

      if (rule.sourceTrackId !== 'all' && rule.sourceTrackId !== note.trackId) {
        return false;
      }

      const min = Math.min(rule.sourceMin, rule.sourceMax);
      const max = Math.max(rule.sourceMin, rule.sourceMax);
      if (note.midi < min || note.midi > max) {
        return false;
      }

      return true;
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

export function createMidiExport(
  source: SourceMidiData,
  events: RemapEvent[],
  fileNameOverride?: string,
): ExportedMidi {
  const midi = new Midi();
  midi.header.tempos = [];
  midi.header.timeSignatures = [];

  const track = midi.addTrack();
  track.name = 'NICS Lighting Triggers';

  events.forEach(event => {
    track.addNote({
      midi: event.targetMidi,
      time: event.time,
      duration: Math.max(0.01, event.duration),
      velocity: clamp01(event.velocity),
    });
  });

  const bytes = midi.toArray();
  const arrayBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(arrayBuffer).set(bytes);
  const blob = new Blob([arrayBuffer], { type: 'audio/midi' });
  const fileName = fileNameOverride ?? `${stripExtension(source.fileName)}.nics-lighting.mid`;

  return {
    blob,
    url: URL.createObjectURL(blob),
    fileName,
    eventCount: events.length,
  };
}

export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) {
    return '0:00';
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60)
    .toString()
    .padStart(2, '0');
  return `${minutes}:${remainingSeconds}`;
}

export function midiNoteLabel(note: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const pitchClass = names[note % 12];
  const octave = Math.floor(note / 12) - 1;
  return `${pitchClass}${octave}`;
}

function buildSourceData(
  fileName: string,
  sourceType: SourceMidiData['sourceType'],
  notes: SourceNote[],
  tracks: SourceTrack[],
): SourceMidiData {
  const minMidi = Math.min(...notes.map(note => note.midi));
  const maxMidi = Math.max(...notes.map(note => note.midi));
  const duration = Math.max(...notes.map(note => note.time + note.duration));

  return {
    fileName,
    sourceType,
    duration,
    notes,
    tracks,
    minMidi,
    maxMidi,
  };
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

function clampMidi(value: number): number {
  return Math.max(0, Math.min(127, value));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
