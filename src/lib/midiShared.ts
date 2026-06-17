import type { LightingConfig, LightingGroup, MappingRule, SourceMidiData } from '../types';

const MIDI_EXTENSIONS = ['.mid', '.midi'];
const DEFAULT_SOURCE_MIN = 36;
const DEFAULT_SOURCE_MAX = 84;

export function isMidiFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return MIDI_EXTENSIONS.some(extension => name.endsWith(extension)) || file.type === 'audio/midi';
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
      allowOverlap: true,
      sourceTrackId: 'all',
      sourceMin: clampMidi(sourceMin),
      sourceMax: clampMidi(Math.min(maxMidi, sourceMax)),
    };
  });
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

function clampMidi(value: number): number {
  return Math.max(0, Math.min(127, value));
}
