import type {
  AutomationLaneId,
  ExportMidiControls,
  TimelineAutomation,
} from '../types';

export const DEFAULT_EXPORT_CONTROLS: ExportMidiControls = {
  brightness: 100,
  color: 100,
  lagUp: 0,
  lagDown: 0,
  gobo: 0,
  noteHoldSeconds: 0.12,
  noteMergeGapSeconds: 0.02,
  headXPhasor: {
    min: 0,
    max: 0,
    speed: 0,
    waveform: 0,
  },
  headYPhasor: {
    min: 0,
    max: 0,
    speed: 0,
    waveform: 0,
  },
  dimmerPhasor: {
    min: 0,
    max: 0,
    speed: 0,
    waveform: 0,
  },
};

export const EXPORT_PITCH_BEND = 2854;
export const EXPORT_CHANNEL_PRESSURE = 71;

export const AUTOMATION_CC_BY_LANE: Record<AutomationLaneId, number> = {
  'fixture-strobe': 20,
  'fixture-pixelBars': 21,
  'fixture-smallMovingHeads': 22,
  'fixture-parcans': 23,
  'fixture-bigMovingHeads': 24,
  'phasor-headX': 10,
  'phasor-headY': 11,
  'phasor-dimmer': 12,
};

export const EXPORT_CONTROL_CHANGE_DEFAULTS: Record<number, number> = {
  1: DEFAULT_EXPORT_CONTROLS.brightness,
  2: DEFAULT_EXPORT_CONTROLS.color,
  3: DEFAULT_EXPORT_CONTROLS.lagUp,
  4: DEFAULT_EXPORT_CONTROLS.lagDown,
  5: DEFAULT_EXPORT_CONTROLS.gobo,
  10: 0,
  11: 0,
  12: 0,
  20: 127,
  21: 127,
  22: 127,
  23: 127,
  24: 127,
  51: 0,
  52: 0,
  53: 0,
  54: 0,
  61: 0,
  62: 0,
  63: 0,
  64: 0,
  69: 0,
  71: 0,
  72: 0,
  73: 0,
  74: 0,
  100: 0,
  101: 0,
  102: 0,
  103: 0,
  104: 0,
  105: 0,
  106: 0,
  107: 0,
  108: 0,
  109: 0,
  110: 0,
  111: 0,
};

export function buildExportControlChanges(controls: ExportMidiControls): Record<number, number> {
  return {
    ...EXPORT_CONTROL_CHANGE_DEFAULTS,
    1: clampMidiControl(controls.brightness),
    2: clampMidiControl(controls.color),
    3: clampMidiControl(controls.lagUp),
    4: clampMidiControl(controls.lagDown),
    5: clampMidiControl(controls.gobo),
    51: clampMidiControl(controls.headXPhasor.min),
    52: clampMidiControl(controls.headXPhasor.max),
    53: clampMidiControl(controls.headXPhasor.speed),
    54: clampMidiControl(controls.headXPhasor.waveform),
    61: clampMidiControl(controls.headYPhasor.min),
    62: clampMidiControl(controls.headYPhasor.max),
    63: clampMidiControl(controls.headYPhasor.speed),
    64: clampMidiControl(controls.headYPhasor.waveform),
    71: clampMidiControl(controls.dimmerPhasor.min),
    72: clampMidiControl(controls.dimmerPhasor.max),
    73: clampMidiControl(controls.dimmerPhasor.speed),
    74: clampMidiControl(controls.dimmerPhasor.waveform),
  };
}

export function buildAutomationInitialControlChanges(
  automation: TimelineAutomation,
): Record<number, number> {
  return Object.entries(AUTOMATION_CC_BY_LANE).reduce<Record<number, number>>(
    (changes, [laneId, controller]) => {
      const blocks = automation[laneId as AutomationLaneId] ?? [];
      changes[controller] = blocks.some(block => block.start <= 0 && block.end > 0) ? 127 : 0;
      return changes;
    },
    {},
  );
}

export function clampMidiControl(value: number): number {
  const safeValue = Number.isFinite(value) ? Math.round(value) : 0;
  return Math.max(0, Math.min(127, safeValue));
}
