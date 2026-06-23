export type SourceType = 'audio' | 'midi';
export type AudioAnalysisMode = 'audio-features' | 'basic-pitch';
export type SourceTrackId = 'all' | string;

export interface LightingGroup {
  id: string;
  label: string;
  topLabel?: string;
  shortLabel: string;
  fixtureType: string;
  color: string;
  noteRange: [number, number];
  notes: number[];
  blendWith?: string[];
}

export interface LightingConfig {
  version: number;
  midiNoteBase: number;
  groups: LightingGroup[];
  uiGroupOrder: string[];
}

export interface SourceTrack {
  id: string;
  name: string;
  index: number | null;
  noteCount: number;
  minMidi: number;
  maxMidi: number;
}

export interface SourceNote {
  id: string;
  trackId: string;
  trackName: string;
  midi: number;
  time: number;
  duration: number;
  velocity: number;
}

export interface SourceMidiData {
  fileName: string;
  sourceType: SourceType;
  analysisMode?: AudioAnalysisMode;
  duration: number;
  notes: SourceNote[];
  tracks: SourceTrack[];
  minMidi: number;
  maxMidi: number;
}

export interface MappingRule {
  groupId: string;
  enabled: boolean;
  allowOverlap: boolean;
  sourceTrackId: SourceTrackId;
  sourceMin: number;
  sourceMax: number;
}

export interface RemapEvent extends SourceNote {
  groupId: string;
  targetMidi: number;
}

export interface PianoRollEvent {
  duration: number;
  sourceMidi: number;
  targetMidi: number;
  time: number;
  velocity: number;
}

export interface BasicPitchNote {
  startTimeSeconds: number;
  durationSeconds: number;
  pitchMidi: number;
  amplitude: number;
}

export interface BasicPitchSettings {
  frameThreshold: number;
  inferOnsets: boolean;
  minNoteLengthFrames: number;
  onsetThreshold: number;
}

export interface AudioCleanupControls {
  confidenceFloor: number;
  mergeGapSeconds: number;
  minDurationSeconds: number;
  pitchMax: number;
  pitchMin: number;
}

export type AudioFeatureGroupId =
  | 'strobe'
  | 'pixelBars'
  | 'smallMovingHeads'
  | 'parcans'
  | 'bigMovingHeads';

export type AudioFeatureGroupDensities = Record<AudioFeatureGroupId, number>;

export interface AudioFeatureSettings {
  bassWeight: number;
  density: number;
  groupDensities: AudioFeatureGroupDensities;
  maxNoteLengthSeconds: number;
  minEventSpacingSeconds: number;
  minNoteLengthSeconds: number;
  onsetThreshold: number;
  sensitivity: number;
}

export interface AudioFeatureDiagnostics {
  bassActivity: number;
  eventsByGroup: Record<string, number>;
  onsetCount: number;
  totalEvents: number;
}

export interface ExportedMidi {
  blob: Blob;
  url: string;
  fileName: string;
  eventCount: number;
}

export interface ExportMidiControls {
  headX: number;
  headY: number;
  brightness: number;
  color: number;
  lagUp: number;
  lagDown: number;
  gobo: number;
  noteHoldSeconds: number;
  noteMergeGapSeconds: number;
  noteVelocityCeiling: number;
  noteVelocityFloor: number;
  fixtureVelocityRanges: Record<string, VelocityRange>;
  headXPhasor: PhasorControls;
  headYPhasor: PhasorControls;
  dimmerPhasor: PhasorControls;
}

export interface VelocityRange {
  floor: number;
  ceiling: number;
}

export interface PhasorControls {
  min: number;
  max: number;
  speed: number;
  waveform: number;
}

export type AutomationLaneId =
  | 'fixture-strobe'
  | 'fixture-pixelBars'
  | 'fixture-smallMovingHeads'
  | 'fixture-parcans'
  | 'fixture-bigMovingHeads'
  | 'phasor-headX'
  | 'phasor-headY'
  | 'phasor-dimmer'
  | 'phasor-liveDetectBrightness';

export interface AutomationBlock {
  id: string;
  start: number;
  end: number;
}

export type TimelineAutomation = Record<AutomationLaneId, AutomationBlock[]>;

export interface SourceSummary {
  fileName: string;
  sourceType: SourceType;
  analysisMode?: AudioAnalysisMode;
  duration: number;
  totalNoteCount: number;
  filteredNoteCount: number;
  minMidi: number;
  maxMidi: number;
  filteredMinMidi: number;
  filteredMaxMidi: number;
  tracks: SourceTrack[];
}

export interface TimelineBin {
  startRatio: number;
  endRatio: number;
  count: number;
}

export interface PipelineViewModel {
  sourceSummary: SourceSummary | null;
  rules: MappingRule[];
  audioCleanup: AudioCleanupControls;
  audioFeatureDiagnostics: AudioFeatureDiagnostics | null;
  audioFeatureSettings: AudioFeatureSettings;
  confidenceFloor: number;
  filteredNoteCount: number;
  remappedEventCount: number;
  eventsByGroup: Record<string, number>;
  eventsByTargetNote: Record<number, number>;
  histogram: number[];
  pianoRollByGroup: Record<string, PianoRollEvent[]>;
  timelineBinsByTargetNote: Record<number, TimelineBin[]>;
  activeWindowsByTargetNote: Record<number, Array<[number, number]>>;
}

export type PipelineRequest =
  | { type: 'load-midi'; fileName: string; arrayBuffer: ArrayBuffer }
  | {
      type: 'load-audio-features';
      duration: number;
      fileName: string;
      sampleRate: number;
      samples: Float32Array;
      settings: AudioFeatureSettings;
    }
  | { type: 'load-basic-pitch'; fileName: string; notes: BasicPitchNote[] }
  | { type: 'set-audio-feature-settings'; settings: AudioFeatureSettings }
  | { type: 'set-audio-cleanup'; controls: AudioCleanupControls }
  | { type: 'set-confidence-floor'; value: number }
  | { type: 'set-rules'; rules: MappingRule[] }
  | { type: 'export-midi'; controls: ExportMidiControls; automation: TimelineAutomation };

export type PipelineResponse =
  | { type: 'ready'; viewModel: PipelineViewModel }
  | { type: 'updated'; viewModel: PipelineViewModel }
  | { type: 'export-ready'; fileName: string; bytes: ArrayBuffer; eventCount: number }
  | { type: 'error'; message: string };
