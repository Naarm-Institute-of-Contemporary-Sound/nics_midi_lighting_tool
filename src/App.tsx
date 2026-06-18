import {
  Activity,
  Download,
  FileMusic,
  Loader2,
  Music2,
  Pause,
  Play,
  RefreshCw,
  SkipBack,
  SlidersHorizontal,
  UploadCloud,
} from 'lucide-react';
import { ChangeEvent, DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import lightingNotesJson from './config/lightingNotes.json';
import { decodeToMonoSamples } from './lib/audio';
import { transcribeWithBasicPitch } from './lib/basicPitchClient';
import {
  AUTOMATION_CC_BY_LANE,
  buildAutomationInitialControlChanges,
  buildExportControlChanges,
  clampMidiControl,
  DEFAULT_EXPORT_CONTROLS,
  EXPORT_CHANNEL_PRESSURE,
  EXPORT_PITCH_BEND,
} from './lib/lightingControls';
import { createDefaultRules, formatSeconds, isMidiFile, midiNoteLabel } from './lib/midiShared';
import type {
  AutomationBlock,
  AutomationLaneId,
  BasicPitchNote,
  ExportedMidi,
  ExportMidiControls,
  LightingConfig,
  LightingGroup,
  MappingRule,
  PipelineResponse,
  PipelineViewModel,
  PhasorControls,
  SourceSummary,
  TimelineAutomation,
} from './types';

const lightingConfig = lightingNotesJson as LightingConfig;

type Status = {
  kind: 'idle' | 'decoding' | 'transcribing' | 'ready' | 'error';
  message: string;
  detail?: string;
  progress: number;
};

type SourceAudioDownload = {
  fileName: string;
  url: string;
};

type BrowserMidiOutputOption = {
  connection: string;
  id: string;
  label: string;
  manufacturer: string;
  state: string;
};

type BrowserMidiDebug = {
  activeNoteCount: number;
  controlCount: number;
  lastEvent: string;
};

type AutomationLane = {
  color: string;
  controller: number;
  id: AutomationLaneId;
  kind: 'fixture' | 'phasor';
  label: string;
  shortLabel: string;
};

type AutomationDragState = {
  blockId: string;
  duration: number;
  laneId: AutomationLaneId;
  mode: 'move' | 'start' | 'end';
  originalEnd: number;
  originalStart: number;
  pointerStartX: number;
  trackWidth: number;
};

type StoredSessionSource =
  | {
      base64: string;
      fileName: string;
      kind: 'midi';
    }
  | {
      fileName: string;
      kind: 'basic-pitch';
      notes: BasicPitchNote[];
    };

type StoredSessionAudio = {
  fileName: string;
  mimeType: string;
  storageKey: string;
};

type StoredAppSession = {
  audio: StoredSessionAudio | null;
  confidenceFloor: number;
  exportControls: ExportMidiControls;
  isAutomationOpen: boolean;
  rules: MappingRule[];
  selectedBrowserMidiOutputId: string;
  source: StoredSessionSource | null;
  timelineAutomation: TimelineAutomation;
  timelineZoom: number;
  version: 1;
};

const initialStatus: Status = {
  kind: 'idle',
  message: 'Drop audio or MIDI',
  progress: 0,
};

const DEFAULT_AUDIO_CONFIDENCE_FLOOR = 0.18;
const PLAYBACK_UPDATE_STEP_SECONDS = 0.06;
const BROWSER_MIDI_CHANNEL = 0;
const BROWSER_MIDI_NOTE_VELOCITY = 100;
const SESSION_STORAGE_KEY = 'nics-midi-lighting-tool:session:v1';
const SESSION_AUDIO_DB_NAME = 'nics-midi-lighting-tool-session';
const SESSION_AUDIO_STORE_NAME = 'audio-blobs';
const SESSION_AUDIO_STORAGE_KEY = 'active-preview-audio';
const AUTOMATION_SNAP_SECONDS = 0.1;
const AUTOMATION_MIN_BLOCK_SECONDS = 0.1;

const AUTOMATION_LANES: AutomationLane[] = [
  {
    id: 'fixture-strobe',
    kind: 'fixture',
    label: 'Strobe fixtures',
    shortLabel: 'STR',
    controller: AUTOMATION_CC_BY_LANE['fixture-strobe'],
    color: '#f35b5b',
  },
  {
    id: 'fixture-pixelBars',
    kind: 'fixture',
    label: 'Pixel bar fixtures',
    shortLabel: 'PIX',
    controller: AUTOMATION_CC_BY_LANE['fixture-pixelBars'],
    color: '#19c6a5',
  },
  {
    id: 'fixture-smallMovingHeads',
    kind: 'fixture',
    label: 'Small moving head fixtures',
    shortLabel: 'SM',
    controller: AUTOMATION_CC_BY_LANE['fixture-smallMovingHeads'],
    color: '#7c9cff',
  },
  {
    id: 'fixture-parcans',
    kind: 'fixture',
    label: 'Parcan fixtures',
    shortLabel: 'PAR',
    controller: AUTOMATION_CC_BY_LANE['fixture-parcans'],
    color: '#8bd85f',
  },
  {
    id: 'fixture-bigMovingHeads',
    kind: 'fixture',
    label: 'Big moving head fixtures',
    shortLabel: 'BIG',
    controller: AUTOMATION_CC_BY_LANE['fixture-bigMovingHeads'],
    color: '#f4b64a',
  },
  {
    id: 'phasor-headX',
    kind: 'phasor',
    label: 'Head X phasor',
    shortLabel: 'HX',
    controller: AUTOMATION_CC_BY_LANE['phasor-headX'],
    color: '#d376ff',
  },
  {
    id: 'phasor-headY',
    kind: 'phasor',
    label: 'Head Y phasor',
    shortLabel: 'HY',
    controller: AUTOMATION_CC_BY_LANE['phasor-headY'],
    color: '#ff75c8',
  },
  {
    id: 'phasor-dimmer',
    kind: 'phasor',
    label: 'Dimmer phasor',
    shortLabel: 'DIM',
    controller: AUTOMATION_CC_BY_LANE['phasor-dimmer'],
    color: '#ffe166',
  },
];

const emptyViewModel: PipelineViewModel = {
  sourceSummary: null,
  rules: createDefaultRules(null, lightingConfig),
  confidenceFloor: 0,
  filteredNoteCount: 0,
  remappedEventCount: 0,
  eventsByGroup: {},
  eventsByTargetNote: {},
  histogram: new Array(18).fill(0),
  timelineBinsByTargetNote: {},
  activeWindowsByTargetNote: {},
};

export default function App() {
  const [initialSession] = useState(() => readStoredAppSession());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previewAudioInputRef = useRef<HTMLInputElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pipelineWorkerRef = useRef<Worker | null>(null);
  const pendingSessionRestoreRef = useRef<StoredAppSession | null>(initialSession);
  const pendingAutomationRestoreRef = useRef<TimelineAutomation | null>(null);
  const rulesFromWorkerRef = useRef(false);
  const confidenceFromWorkerRef = useRef(false);
  const playbackTimeRef = useRef(0);
  const lastPlaybackRenderRef = useRef(0);
  const browserMidiAccessRef = useRef<MIDIAccess | null>(null);
  const browserMidiOutputRef = useRef<MIDIOutput | null>(null);
  const activeBrowserMidiNotesRef = useRef<Set<number>>(new Set());
  const activeBrowserAutomationRef = useRef<Record<number, number>>({});
  const [viewModel, setViewModel] = useState<PipelineViewModel>(emptyViewModel);
  const [sourceSummary, setSourceSummary] = useState<SourceSummary | null>(null);
  const [rules, setRules] = useState<MappingRule[]>(
    () => initialSession?.rules ?? createDefaultRules(null, lightingConfig),
  );
  const [status, setStatus] = useState<Status>(initialStatus);
  const [isDragActive, setIsDragActive] = useState(false);
  const [exportedMidi, setExportedMidi] = useState<ExportedMidi | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [sourceAudioDownload, setSourceAudioDownload] = useState<SourceAudioDownload | null>(null);
  const [sessionAudio, setSessionAudio] = useState<StoredSessionAudio | null>(
    () => initialSession?.audio ?? null,
  );
  const [sessionSource, setSessionSource] = useState<StoredSessionSource | null>(
    () => initialSession?.source ?? null,
  );
  const [playbackTime, setPlaybackTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [confidenceFloor, setConfidenceFloor] = useState(
    initialSession?.confidenceFloor ?? DEFAULT_AUDIO_CONFIDENCE_FLOOR,
  );
  const [exportControls, setExportControls] = useState<ExportMidiControls>(
    initialSession?.exportControls ?? DEFAULT_EXPORT_CONTROLS,
  );
  const [timelineAutomation, setTimelineAutomation] = useState<TimelineAutomation>(() =>
    initialSession?.timelineAutomation ?? createDefaultTimelineAutomation(0),
  );
  const [isAutomationOpen, setIsAutomationOpen] = useState(initialSession?.isAutomationOpen ?? false);
  const [browserMidiEnabled, setBrowserMidiEnabled] = useState(false);
  const [browserMidiOutputs, setBrowserMidiOutputs] = useState<BrowserMidiOutputOption[]>([]);
  const [selectedBrowserMidiOutputId, setSelectedBrowserMidiOutputId] = useState(
    initialSession?.selectedBrowserMidiOutputId ?? '',
  );
  const [browserMidiStatus, setBrowserMidiStatus] = useState('Off');
  const [browserMidiDebug, setBrowserMidiDebug] = useState<BrowserMidiDebug>({
    activeNoteCount: 0,
    controlCount: 0,
    lastEvent: 'None',
  });
  const [timelineZoom, setTimelineZoom] = useState(initialSession?.timelineZoom ?? 1);
  const [hoveredTimelineNote, setHoveredTimelineNote] = useState<{
    groupLabel: string;
    note: number;
    count: number;
  } | null>(null);

  const groupMap = useMemo(() => {
    return new Map<string, LightingGroup>(lightingConfig.groups.map(group => [group.id, group]));
  }, []);

  const orderedGroups = useMemo(() => {
    const configuredGroups = lightingConfig.uiGroupOrder
        .map(groupId => groupMap.get(groupId))
        .filter((group): group is LightingGroup => Boolean(group));
    const remainingGroups = lightingConfig.groups.filter(
      group => !lightingConfig.uiGroupOrder.includes(group.id),
    );

    return configuredGroups.concat(remainingGroups);
  }, [groupMap]);

  const activeTargetNotes = useMemo(() => {
    const activeNotes = new Set<number>();
    Object.entries(viewModel.activeWindowsByTargetNote).forEach(([note, windows]) => {
      if (isTimeInWindows(playbackTime, windows)) {
        activeNotes.add(Number(note));
      }
    });
    return activeNotes;
  }, [playbackTime, viewModel.activeWindowsByTargetNote]);

  const eventsByGroup = viewModel.eventsByGroup;
  const eventsByTargetNote = viewModel.eventsByTargetNote;
  const histogram = viewModel.histogram;
  const sourcePitchMin = sourceSummary?.filteredMinMidi ?? sourceSummary?.minMidi ?? 0;
  const sourcePitchMax = sourceSummary?.filteredMaxMidi ?? sourceSummary?.maxMidi ?? 127;
  const sourcePitchSpan = Math.max(1, sourcePitchMax - sourcePitchMin);

  useEffect(() => {
    setExportedMidi(current => {
      if (current) {
        URL.revokeObjectURL(current.url);
      }
      return null;
    });
  }, [confidenceFloor, exportControls, rules, sourceSummary, timelineAutomation]);

  useEffect(() => {
    writeStoredAppSession({
      audio: sessionAudio,
      confidenceFloor,
      exportControls,
      isAutomationOpen,
      rules,
      selectedBrowserMidiOutputId,
      source: sessionSource,
      timelineAutomation,
      timelineZoom,
      version: 1,
    });
  }, [
    confidenceFloor,
    exportControls,
    isAutomationOpen,
    rules,
    selectedBrowserMidiOutputId,
    sessionAudio,
    sessionSource,
    timelineAutomation,
    timelineZoom,
  ]);

  const applyViewModel = useCallback((nextViewModel: PipelineViewModel) => {
    rulesFromWorkerRef.current = true;
    confidenceFromWorkerRef.current = true;
    setViewModel(nextViewModel);
    setSourceSummary(nextViewModel.sourceSummary);
    setRules(nextViewModel.rules);
    setConfidenceFloor(nextViewModel.confidenceFloor);
  }, []);

  useEffect(() => {
    const worker = new Worker(new URL('./workers/pipeline.worker.ts', import.meta.url), {
      type: 'module',
    });

    worker.onmessage = (event: MessageEvent<PipelineResponse>) => {
      const message = event.data;
      if (message.type === 'ready' || message.type === 'updated') {
        const restoredSession = pendingSessionRestoreRef.current;
        applyViewModel(message.viewModel);

        if (message.type === 'ready' && restoredSession?.source) {
          pendingAutomationRestoreRef.current = restoredSession.timelineAutomation;
          pendingSessionRestoreRef.current = null;

          if (restoredSession.confidenceFloor !== message.viewModel.confidenceFloor) {
            worker.postMessage({
              type: 'set-confidence-floor',
              value: restoredSession.confidenceFloor,
            });
          }

          if (restoredSession.rules.length > 0) {
            worker.postMessage({
              type: 'set-rules',
              rules: restoredSession.rules,
            });
          }
        }

        setStatus(current =>
          current.kind === 'decoding' || current.kind === 'transcribing'
            ? {
                kind: 'ready',
                message: `${message.viewModel.filteredNoteCount.toLocaleString()} source notes ready`,
                detail:
                  message.viewModel.sourceSummary?.sourceType === 'audio'
                    ? `${Math.round(
                        message.viewModel.confidenceFloor * 100,
                      )}% confidence floor kept ${message.viewModel.filteredNoteCount.toLocaleString()} of ${message.viewModel.sourceSummary.totalNoteCount.toLocaleString()} Basic Pitch notes.`
                    : `${message.viewModel.sourceSummary?.fileName ?? 'MIDI'} is ready for downmapping.`,
                progress: 1,
              }
            : current,
        );
        return;
      }

      if (message.type === 'export-ready') {
        const blob = new Blob([message.bytes], { type: 'audio/midi' });
        const nextExport = {
          blob,
          url: URL.createObjectURL(blob),
          fileName: message.fileName,
          eventCount: message.eventCount,
        };
        setExportedMidi(current => {
          if (current) {
            URL.revokeObjectURL(current.url);
          }
          return nextExport;
        });

        const anchor = document.createElement('a');
        anchor.href = nextExport.url;
        anchor.download = nextExport.fileName;
        anchor.click();

        setStatus({
          kind: 'ready',
          message: `${message.eventCount.toLocaleString()} lighting notes exported`,
          detail: message.fileName,
          progress: 1,
        });
        return;
      }

      setStatus({
        kind: 'error',
        message: 'Pipeline issue',
        detail: message.message,
        progress: 0,
      });
    };

    pipelineWorkerRef.current = worker;

    const restoredSession = pendingSessionRestoreRef.current;
    if (restoredSession?.source) {
      setStatus({
        kind: 'decoding',
        message: 'Restoring session',
        detail: restoredSession.source.fileName,
        progress: 0.18,
      });

      try {
        restoreStoredSource(worker, restoredSession.source);
      } catch (error) {
        pendingSessionRestoreRef.current = null;
        setSessionSource(null);
        setStatus({
          kind: 'error',
          message: 'Could not restore session source',
          detail: error instanceof Error ? error.message : 'Stored source was unreadable.',
          progress: 0,
        });
      }
    }

    return () => {
      worker.terminate();
      pipelineWorkerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!sourceSummary) {
      return;
    }

    if (rulesFromWorkerRef.current) {
      rulesFromWorkerRef.current = false;
      return;
    }

    const timeout = window.setTimeout(() => {
      pipelineWorkerRef.current?.postMessage({ type: 'set-rules', rules });
    }, 80);

    return () => window.clearTimeout(timeout);
  }, [rules, sourceSummary]);

  useEffect(() => {
    if (!sourceSummary) {
      return;
    }

    if (confidenceFromWorkerRef.current) {
      confidenceFromWorkerRef.current = false;
      return;
    }

    const timeout = window.setTimeout(() => {
      pipelineWorkerRef.current?.postMessage({
        type: 'set-confidence-floor',
        value: confidenceFloor,
      });
    }, 80);

    return () => window.clearTimeout(timeout);
  }, [confidenceFloor, sourceSummary]);

  useEffect(() => {
    if (pendingAutomationRestoreRef.current) {
      setTimelineAutomation(pendingAutomationRestoreRef.current);
      pendingAutomationRestoreRef.current = null;
      return;
    }

    setTimelineAutomation(createDefaultTimelineAutomation(sourceSummary?.duration ?? 0));
  }, [sourceSummary?.fileName, sourceSummary?.duration]);

  useEffect(() => {
    return () => {
      if (exportedMidi) {
        URL.revokeObjectURL(exportedMidi.url);
      }
    };
  }, [exportedMidi]);

  useEffect(() => {
    return () => {
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
      }
    };
  }, [audioUrl]);

  useEffect(() => {
    let isCancelled = false;

    if (!initialSession?.audio) {
      return;
    }

    restoreStoredAudio(initialSession.audio)
      .then(restoredAudio => {
        if (isCancelled) {
          URL.revokeObjectURL(restoredAudio.url);
          return;
        }

        setAudioUrl(current => {
          if (current) {
            URL.revokeObjectURL(current);
          }
          return restoredAudio.url;
        });
        setSourceAudioDownload(restoredAudio);
      })
      .catch(error => {
        if (isCancelled) {
          return;
        }

        setSessionAudio(null);
        console.warn('Could not restore session audio.', error);
      });

    return () => {
      isCancelled = true;
    };
  }, [initialSession]);

  useEffect(() => {
    if (!isPlaying) {
      return;
    }

    let animationFrame = 0;
    const syncPlaybackTime = () => {
      const audio = audioRef.current;
      if (audio) {
        updatePlaybackTime(audio.currentTime);
      }
      animationFrame = window.requestAnimationFrame(syncPlaybackTime);
    };

    animationFrame = window.requestAnimationFrame(syncPlaybackTime);

    return () => window.cancelAnimationFrame(animationFrame);
  }, [isPlaying]);

  useEffect(() => {
    let isCancelled = false;

    if (!browserMidiEnabled) {
      stopBrowserMidiNotes();
      stopBrowserMidiAutomation();
      browserMidiOutputRef.current = null;
      setBrowserMidiStatus('Off');
      setBrowserMidiDebug(current => ({
        ...current,
        activeNoteCount: 0,
      }));
      return;
    }

    if (!navigator.requestMIDIAccess) {
      setBrowserMidiEnabled(false);
      setBrowserMidiStatus('Web MIDI unavailable in this browser');
      return;
    }

    setBrowserMidiStatus('Requesting MIDI access');
    navigator
      .requestMIDIAccess({ sysex: false })
      .then(access => {
        if (isCancelled) {
          return;
        }

        browserMidiAccessRef.current = access;
        access.onstatechange = () => {
          const refreshedOutputs = syncBrowserMidiOutputs(access);
          setSelectedBrowserMidiOutputId(currentOutputId =>
            getPreferredBrowserMidiOutputId(refreshedOutputs, currentOutputId),
          );
        };
        const outputs = syncBrowserMidiOutputs(access);
        const preferredOutputId = getPreferredBrowserMidiOutputId(outputs, selectedBrowserMidiOutputId);
        setSelectedBrowserMidiOutputId(preferredOutputId);
        const output = preferredOutputId ? access.outputs.get(preferredOutputId) ?? null : null;

        if (!output) {
          browserMidiOutputRef.current = null;
          setBrowserMidiStatus('No MIDI output found');
          return;
        }

        browserMidiOutputRef.current = output;
        sendBrowserMidiDefaults(output, exportControls, timelineAutomation);
        updateBrowserMidiAutomation(output, playbackTimeRef.current, true);
        setBrowserMidiStatus(`Output: ${getBrowserMidiOutputLabel(output)}`);
      })
      .catch(error => {
        if (isCancelled) {
          return;
        }

        browserMidiOutputRef.current = null;
        setBrowserMidiEnabled(false);
        setBrowserMidiStatus(error instanceof Error ? error.message : 'MIDI access denied');
      });

    return () => {
      isCancelled = true;
      if (browserMidiAccessRef.current) {
        browserMidiAccessRef.current.onstatechange = null;
      }
      stopBrowserMidiNotes();
    };
  }, [browserMidiEnabled]);

  useEffect(() => {
    if (!browserMidiEnabled || !browserMidiAccessRef.current) {
      return;
    }

    const output = selectedBrowserMidiOutputId
      ? browserMidiAccessRef.current.outputs.get(selectedBrowserMidiOutputId) ?? null
      : null;
    stopBrowserMidiNotes();
    browserMidiOutputRef.current = output;

    if (!output) {
      setBrowserMidiStatus('No MIDI output selected');
      return;
    }

    sendBrowserMidiDefaults(output, exportControls, timelineAutomation);
    updateBrowserMidiAutomation(output, playbackTimeRef.current, true);
    setBrowserMidiStatus(`Output: ${getBrowserMidiOutputLabel(output)}`);
  }, [browserMidiEnabled, selectedBrowserMidiOutputId]);

  useEffect(() => {
    if (browserMidiEnabled && browserMidiOutputRef.current) {
      sendBrowserMidiDefaults(browserMidiOutputRef.current, exportControls, timelineAutomation);
      updateBrowserMidiAutomation(browserMidiOutputRef.current, playbackTimeRef.current, true);
    }
  }, [browserMidiEnabled, exportControls, timelineAutomation]);

  useEffect(() => {
    if (!browserMidiEnabled || !isPlaying) {
      stopBrowserMidiNotes();
      return;
    }

    let animationFrame = 0;
    const syncBrowserMidiNotes = () => {
      const output = browserMidiOutputRef.current;
      if (output) {
        const nextActiveNotes = new Set<number>();
        Object.entries(viewModel.activeWindowsByTargetNote).forEach(([note, windows]) => {
          if (isTimeInWindows(playbackTimeRef.current, windows)) {
            nextActiveNotes.add(Number(note));
          }
        });
        updateBrowserMidiNotes(output, nextActiveNotes);
        updateBrowserMidiAutomation(output, playbackTimeRef.current);
      }
      animationFrame = window.requestAnimationFrame(syncBrowserMidiNotes);
    };

    animationFrame = window.requestAnimationFrame(syncBrowserMidiNotes);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      stopBrowserMidiNotes();
      stopBrowserMidiAutomation();
    };
  }, [browserMidiEnabled, isPlaying, timelineAutomation, viewModel.activeWindowsByTargetNote]);

  async function loadFile(file: File) {
    setExportedMidi(null);
    setViewModel(emptyViewModel);
    setSourceSummary(null);
    setSessionSource(null);
    setSessionAudio(null);
    setHoveredTimelineNote(null);
    updatePlaybackTime(0, true);
    setIsPlaying(false);
    const isMidiSource = isMidiFile(file);
    const nextAudioUrl = isMidiSource ? null : URL.createObjectURL(file);
    setAudioUrl(current => {
      if (current) {
        URL.revokeObjectURL(current);
      }
      return nextAudioUrl;
    });
    setSourceAudioDownload(
      nextAudioUrl
        ? {
            fileName: file.name,
            url: nextAudioUrl,
          }
        : null,
    );
    setStatus({
      kind: isMidiSource ? 'decoding' : 'decoding',
      message: isMidiSource ? 'Reading MIDI' : 'Decoding audio',
      detail: file.name,
      progress: 0.08,
    });

    try {
      if (isMidiSource) {
        const arrayBuffer = await file.arrayBuffer();
        const storedSource: StoredSessionSource = {
          base64: arrayBufferToBase64(arrayBuffer),
          fileName: file.name,
          kind: 'midi',
        };
        setSessionSource(storedSource);
        pipelineWorkerRef.current?.postMessage(
          {
            type: 'load-midi',
            fileName: file.name,
            arrayBuffer,
          },
          [arrayBuffer],
        );
        return;
      }

      setSessionAudio(await createStoredAudioSafely(file));
      const notes = await transcribeAudioFile(file);
      setSessionSource({
        fileName: file.name,
        kind: 'basic-pitch',
        notes,
      });
      pipelineWorkerRef.current?.postMessage({
        type: 'load-basic-pitch',
        fileName: file.name,
        notes,
      });
    } catch (error) {
      setSourceSummary(null);
      setViewModel(emptyViewModel);
      setSessionSource(null);
      setSourceAudioDownload(null);
      setAudioUrl(current => {
        if (current) {
          URL.revokeObjectURL(current);
        }
        return null;
      });
      setStatus({
        kind: 'error',
        message: `Could not process ${file.name}`,
        detail: error instanceof Error ? error.message : 'File import failed.',
        progress: 0,
      });
    }
  }

  async function transcribeAudioFile(file: File) {
    setStatus({
      kind: 'decoding',
      message: 'Preparing audio',
      detail: 'Decoding and resampling to mono 22.05 kHz for Basic Pitch.',
      progress: 0.06,
    });

    const decoded = await decodeToMonoSamples(file);

    setStatus({
      kind: 'transcribing',
      message: 'Basic Pitch 0%',
      detail: `${formatSeconds(decoded.duration)} of audio queued for transcription.`,
      progress: 0.12,
    });

    const notes = await transcribeWithBasicPitch(decoded.samples, progress => {
      const percent = Math.round(progress * 100);
      setStatus({
        kind: 'transcribing',
        message: `Basic Pitch ${percent}%`,
        detail: 'Detecting note events in the browser. Larger files can take a minute.',
        progress: 0.12 + progress * 0.86,
      });
    });

    return notes;
  }

  function handleFileInput(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) {
      void loadFile(file);
    }
    event.target.value = '';
  }

  function handlePreviewAudioInput(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) {
      void attachPreviewAudio(file);
    }
    event.target.value = '';
  }

  async function attachPreviewAudio(file: File) {
    if (sourceSummary?.sourceType !== 'midi') {
      return;
    }

    setSessionAudio(await createStoredAudioSafely(file));
    const nextAudioUrl = URL.createObjectURL(file);
    setAudioUrl(current => {
      if (current) {
        URL.revokeObjectURL(current);
      }
      return nextAudioUrl;
    });
    setSourceAudioDownload({
      fileName: file.name,
      url: nextAudioUrl,
    });
    setIsPlaying(false);
    updatePlaybackTime(0, true);
    setStatus({
      kind: 'ready',
      message: 'Preview audio attached',
      detail: `${file.name} will play from 0 alongside the loaded MIDI.`,
      progress: 1,
    });
  }

  function handleDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setIsDragActive(false);
    const file = event.dataTransfer.files?.[0];
    if (file) {
      void loadFile(file);
    }
  }

  function updateRule(groupId: string, patch: Partial<MappingRule>) {
    setRules(current =>
      current.map(rule => (rule.groupId === groupId ? { ...rule, ...patch } : rule)),
    );
  }

  function updateRuleRange(groupId: string, patch: Partial<Pick<MappingRule, 'sourceMin' | 'sourceMax'>>) {
    setRules(current =>
      current.map(rule => {
        if (rule.groupId !== groupId) {
          return rule;
        }

        const nextMin = clampPitch(patch.sourceMin ?? rule.sourceMin, sourcePitchMin, sourcePitchMax);
        const nextMax = clampPitch(patch.sourceMax ?? rule.sourceMax, sourcePitchMin, sourcePitchMax);

        return {
          ...rule,
          sourceMin: Math.min(nextMin, nextMax),
          sourceMax: Math.max(nextMin, nextMax),
        };
      }),
    );
  }

  function resetRules() {
    const nextRules = createDefaultRulesFromSummary(sourceSummary);
    setRules(nextRules);
    pipelineWorkerRef.current?.postMessage({
      type: 'set-rules',
      rules: nextRules,
    });
  }

  function togglePlayback() {
    const audio = audioRef.current;
    if (!audioUrl || !audio) {
      return;
    }

    if (audio.paused) {
      void audio.play();
      return;
    }

    audio.pause();
  }

  function restartPlayback() {
    const audio = audioRef.current;
    if (audio) {
      audio.currentTime = 0;
    }
    updatePlaybackTime(0, true);
  }

  function updatePlaybackTime(nextTime: number, force = false) {
    playbackTimeRef.current = nextTime;
    if (force || Math.abs(lastPlaybackRenderRef.current - nextTime) >= PLAYBACK_UPDATE_STEP_SECONDS) {
      lastPlaybackRenderRef.current = nextTime;
      setPlaybackTime(nextTime);
    }
  }

  function handleSeek(value: number) {
    const nextTime = Math.max(0, Math.min(value, sourceSummary?.duration ?? 0));
    const audio = audioRef.current;
    if (audio) {
      audio.currentTime = nextTime;
    }
    updatePlaybackTime(nextTime, true);
  }

  function exportMidi() {
    if (!sourceSummary || viewModel.remappedEventCount === 0) {
      setStatus({
        kind: 'error',
        message: 'No mapped notes to export.',
        progress: 0,
      });
      return;
    }

    pipelineWorkerRef.current?.postMessage({
      type: 'export-midi',
      controls: exportControls,
      automation: timelineAutomation,
    });
  }

  function updateExportControl(
    key: 'brightness' | 'color' | 'lagUp' | 'lagDown' | 'gobo',
    value: number,
  ) {
    setExportControls(current => ({
      ...current,
      [key]: clampMidiControl(value),
    }));
  }

  function updatePhasorControl(
    phasorKey: 'headXPhasor' | 'headYPhasor' | 'dimmerPhasor',
    controlKey: keyof PhasorControls,
    value: number,
  ) {
    setExportControls(current => ({
      ...current,
      [phasorKey]: {
        ...current[phasorKey],
        [controlKey]: clampMidiControl(Number(value)),
      },
    }));
  }

  function updateBrowserMidiNotes(output: MIDIOutput, nextActiveNotes: Set<number>) {
    const activeNotes = activeBrowserMidiNotesRef.current;
    let lastEvent = '';

    activeNotes.forEach(note => {
      if (!nextActiveNotes.has(note)) {
        output.send([0x80 + BROWSER_MIDI_CHANNEL, note, 0]);
        activeNotes.delete(note);
        lastEvent = `Note off ${note}`;
      }
    });

    nextActiveNotes.forEach(note => {
      const safeNote = clampMidiControl(note);
      if (!activeNotes.has(safeNote)) {
        output.send([0x90 + BROWSER_MIDI_CHANNEL, safeNote, BROWSER_MIDI_NOTE_VELOCITY]);
        activeNotes.add(safeNote);
        lastEvent = `Note on ${safeNote}`;
      }
    });

    if (lastEvent || browserMidiDebug.activeNoteCount !== activeNotes.size) {
      setBrowserMidiDebug(current => ({
        ...current,
        activeNoteCount: activeNotes.size,
        lastEvent: lastEvent || current.lastEvent,
      }));
    }
  }

  function stopBrowserMidiNotes() {
    const output = browserMidiOutputRef.current;
    if (!output) {
      activeBrowserMidiNotesRef.current.clear();
      return;
    }

    activeBrowserMidiNotesRef.current.forEach(note => {
      output.send([0x80 + BROWSER_MIDI_CHANNEL, note, 0]);
    });
    activeBrowserMidiNotesRef.current.clear();
    setBrowserMidiDebug(current => ({
      ...current,
      activeNoteCount: 0,
      lastEvent: 'All notes off',
    }));
  }

  function sendBrowserMidiDefaults(
    output: MIDIOutput,
    controls: ExportMidiControls,
    automation: TimelineAutomation,
  ) {
    const pitchBendValue = clampPitchBendValue(8192 + EXPORT_PITCH_BEND);
    output.send([0xe0 + BROWSER_MIDI_CHANNEL, pitchBendValue & 0x7f, (pitchBendValue >> 7) & 0x7f]);
    output.send([0xd0 + BROWSER_MIDI_CHANNEL, clampMidiControl(EXPORT_CHANNEL_PRESSURE)]);
    const controlChanges = {
      ...buildExportControlChanges(controls),
      ...buildAutomationInitialControlChanges(automation),
    };
    Object.entries(controlChanges).forEach(([controller, value]) => {
      output.send([0xb0 + BROWSER_MIDI_CHANNEL, Number(controller), clampMidiControl(value)]);
    });
    activeBrowserAutomationRef.current = { ...controlChanges };
    setBrowserMidiDebug(current => ({
      ...current,
      controlCount: Object.keys(controlChanges).length + 2,
      lastEvent: `Defaults sent to ${getBrowserMidiOutputLabel(output)}`,
    }));
  }

  function updateBrowserMidiAutomation(output: MIDIOutput, time: number, force = false) {
    const nextValues = getAutomationControlValuesAtTime(timelineAutomation, time);
    const currentValues = activeBrowserAutomationRef.current;
    let lastEvent = '';
    let sentCount = 0;

    Object.entries(nextValues).forEach(([controllerKey, value]) => {
      const controller = Number(controllerKey);
      const safeValue = clampMidiControl(value);
      if (force || currentValues[controller] !== safeValue) {
        output.send([0xb0 + BROWSER_MIDI_CHANNEL, controller, safeValue]);
        currentValues[controller] = safeValue;
        sentCount += 1;
        lastEvent = `CC ${controller} ${safeValue}`;
      }
    });

    if (sentCount > 0) {
      setBrowserMidiDebug(current => ({
        ...current,
        lastEvent,
      }));
    }
  }

  function stopBrowserMidiAutomation() {
    const output = browserMidiOutputRef.current;
    if (!output) {
      return;
    }

    ['phasor-headX', 'phasor-headY', 'phasor-dimmer'].forEach(laneId => {
      const controller = AUTOMATION_CC_BY_LANE[laneId as AutomationLaneId];
      output.send([0xb0 + BROWSER_MIDI_CHANNEL, controller, 0]);
      activeBrowserAutomationRef.current[controller] = 0;
    });
  }

  function sendBrowserMidiAllNotesOff() {
    const output = browserMidiOutputRef.current;
    if (!output) {
      setBrowserMidiStatus('No MIDI output selected');
      return;
    }

    for (let note = 0; note <= 127; note += 1) {
      output.send([0x80 + BROWSER_MIDI_CHANNEL, note, 0]);
    }
    output.send([0xb0 + BROWSER_MIDI_CHANNEL, 123, 0]);
    output.send([0xb0 + BROWSER_MIDI_CHANNEL, 120, 0]);
    activeBrowserMidiNotesRef.current.clear();
    stopBrowserMidiAutomation();
    setBrowserMidiDebug(current => ({
      ...current,
      activeNoteCount: 0,
      lastEvent: 'Panic: all notes off',
    }));
  }

  function syncBrowserMidiOutputs(access: MIDIAccess): BrowserMidiOutputOption[] {
    const outputs = Array.from(access.outputs.values()).map(output => ({
      connection: output.connection ?? 'unknown',
      id: output.id,
      label: getBrowserMidiOutputLabel(output),
      manufacturer: output.manufacturer ?? '',
      state: output.state ?? 'unknown',
    }));
    setBrowserMidiOutputs(outputs);
    return outputs;
  }

  function getSelectedBrowserMidiOutputLabel() {
    return (
      browserMidiOutputs.find(output => output.id === selectedBrowserMidiOutputId)?.label ??
      'No output selected'
    );
  }

  function exportAudio() {
    if (!sourceAudioDownload) {
      return;
    }

    const anchor = document.createElement('a');
    anchor.href = sourceAudioDownload.url;
    anchor.download = sourceAudioDownload.fileName;
    anchor.click();
  }

  const isBusy = status.kind === 'decoding' || status.kind === 'transcribing';
  const timelineDuration = Math.max(sourceSummary?.duration ?? 0, 0.01);
  const canAttachPreviewAudio = sourceSummary?.sourceType === 'midi';

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div>
            <h1>NICS MIDI Lighting Tool</h1>
            <p>Client-side pitch conversion and fixture-note pageantry</p>
          </div>
        </div>
        <div className={`status-pill status-${status.kind}`}>
          {isBusy ? <Loader2 size={16} className="spin" /> : <Activity size={16} />}
          <span>{status.message}</span>
        </div>
      </header>

      <section className="panel target-preview-panel" aria-label="MIDI note preview">
        <div className="target-preview-header">
          <div className="section-heading">
            <h2>MIDI Note Preview</h2>
          </div>
        </div>

        <div className="target-strip">
          {lightingConfig.groups.map(group => (
            <div className="target-group" key={group.id}>
              <div className="target-group-label">
                <span>{group.topLabel ?? group.label}</span>
                <small>MIDI {group.noteRange[0]}-{group.noteRange[1]}</small>
              </div>
              <div className="target-notes">
                {group.notes.map(note => (
                  <span
                    className={`target-note ${activeTargetNotes.has(note) ? 'is-active' : ''}`}
                    key={`${group.id}-${note}`}
                    style={{ '--note-color': group.color } as React.CSSProperties}
                    title={`${group.label}: MIDI ${note} ${midiNoteLabel(note)}`}
                  >
                    <strong>{note}</strong>
                    <small>{midiNoteLabel(note)}</small>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="panel timeline-panel" aria-label="MIDI timeline">
        <audio
          ref={audioRef}
          src={audioUrl ?? undefined}
          onEnded={() => setIsPlaying(false)}
          onPause={() => setIsPlaying(false)}
          onPlay={() => setIsPlaying(true)}
          onTimeUpdate={event => updatePlaybackTime(event.currentTarget.currentTime)}
        />
        <div className="timeline-toolbar">
          <div className="section-heading">
            <h2>MIDI Timeline</h2>
          </div>
          <div className="transport-controls">
            {canAttachPreviewAudio ? (
              <button
                className="secondary-action attach-audio-action"
                type="button"
                onClick={() => previewAudioInputRef.current?.click()}
              >
                <Music2 size={16} />
                {audioUrl ? 'Replace preview audio' : 'Attach preview audio'}
              </button>
            ) : null}
            <button
              className="icon-button"
              type="button"
              onClick={restartPlayback}
              disabled={!sourceSummary}
              title="Restart"
            >
              <SkipBack size={17} />
            </button>
            <button
              className="primary-action transport-play"
              type="button"
              onClick={togglePlayback}
              disabled={!audioUrl || !sourceSummary}
            >
              {isPlaying ? <Pause size={18} /> : <Play size={18} />}
              {isPlaying ? 'Pause' : 'Play'}
            </button>
            <span className="timecode">
              {formatSeconds(playbackTime)} / {formatSeconds(sourceSummary?.duration ?? 0)}
            </span>
          </div>
        </div>

        <input
          className="timeline-scrubber"
          type="range"
          min={0}
          max={timelineDuration}
          step={0.01}
          value={Math.min(playbackTime, timelineDuration)}
          disabled={!sourceSummary}
          onChange={event => handleSeek(Number(event.target.value))}
          aria-label="Timeline position"
        />

        <div className="timeline-stage">
          <TimelineCanvas
            activeWindowsByTargetNote={viewModel.activeWindowsByTargetNote}
            duration={timelineDuration}
            eventsByTargetNote={eventsByTargetNote}
            groups={orderedGroups}
            isPlaying={isPlaying}
            onHoverNote={setHoveredTimelineNote}
            playbackTime={playbackTime}
            playbackTimeRef={playbackTimeRef}
            setZoom={setTimelineZoom}
            timelineBinsByTargetNote={viewModel.timelineBinsByTargetNote}
            zoom={timelineZoom}
          />
        </div>
        <div className="timeline-hover-readout">
          {hoveredTimelineNote ? (
            <>
              <strong>
                MIDI {hoveredTimelineNote.note} {midiNoteLabel(hoveredTimelineNote.note)}
              </strong>
              <span>{hoveredTimelineNote.groupLabel}</span>
              <em>{hoveredTimelineNote.count.toLocaleString()} events</em>
            </>
          ) : (
            <span>Hover a timeline row for note density.</span>
          )}
        </div>

        <details
          className="timeline-automation-panel"
          open={isAutomationOpen}
          onToggle={event => setIsAutomationOpen(event.currentTarget.open)}
        >
          <summary>
            <SlidersHorizontal size={16} />
            Timeline enable automation
          </summary>
          <TimelineAutomationEditor
            automation={timelineAutomation}
            duration={timelineDuration}
            lanes={AUTOMATION_LANES}
            playbackTime={playbackTime}
            setAutomation={setTimelineAutomation}
          />
        </details>
      </section>

      <div className="tool-grid">
        <section className="panel import-panel" aria-label="Import">
          <button
            className={`drop-zone ${isDragActive ? 'drag-active' : ''}`}
            disabled={isBusy}
            onClick={() => fileInputRef.current?.click()}
            onDragEnter={event => {
              event.preventDefault();
              setIsDragActive(true);
            }}
            onDragOver={event => event.preventDefault()}
            onDragLeave={() => setIsDragActive(false)}
            onDrop={handleDrop}
            type="button"
          >
            <UploadCloud size={30} />
            <strong>{isBusy ? 'Processing' : 'Drop or select file'}</strong>
            <span>WAV MP3 FLAC OGG MID MIDI</span>
            <div className="progress-track" aria-hidden="true">
              <div className="progress-fill" style={{ width: `${status.progress * 100}%` }} />
            </div>
            <span className="progress-percent">{Math.round(status.progress * 100)}%</span>
          </button>
          <input
            ref={fileInputRef}
            className="sr-only"
            type="file"
            accept="audio/*,.mid,.midi"
            onChange={handleFileInput}
          />
          <input
            ref={previewAudioInputRef}
            className="sr-only"
            type="file"
            accept="audio/*"
            onChange={handlePreviewAudioInput}
          />

          <div className="source-summary">
            <div className="section-heading">
              <FileMusic size={18} />
            <h2>Source</h2>
          </div>
            <div className={`conversion-feedback conversion-${status.kind}`}>
              <strong>{status.message}</strong>
              {status.detail ? <span>{status.detail}</span> : null}
            </div>
            {sourceSummary ? (
              <>
                {sourceSummary.sourceType === 'audio' ? (
                  <label className="confidence-control">
                    <span>
                      Basic Pitch cull
                      <strong>{Math.round(confidenceFloor * 100)}%</strong>
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={0.95}
                      step={0.01}
                      value={confidenceFloor}
                      onChange={event => setConfidenceFloor(Number(event.target.value))}
                    />
                    <small>
                      Keeping {viewModel.filteredNoteCount.toLocaleString()} of{' '}
                      {sourceSummary.totalNoteCount.toLocaleString()} detections
                    </small>
                  </label>
                ) : null}
                {sourceSummary.sourceType === 'midi' ? (
                  <div className="preview-audio-card">
                    <div>
                      <strong>Preview audio</strong>
                      <span>
                        {audioUrl
                          ? sourceAudioDownload?.fileName ?? 'Audio attached'
                          : 'Attach the matching song file for synced playback preview.'}
                      </span>
                    </div>
                    <button
                      className="secondary-action"
                      type="button"
                      onClick={() => previewAudioInputRef.current?.click()}
                    >
                      <Music2 size={16} />
                      {audioUrl ? 'Replace audio' : 'Attach audio'}
                    </button>
                  </div>
                ) : null}
                <dl className="metric-grid">
                  <div>
                    <dt>File</dt>
                    <dd title={sourceSummary.fileName}>{sourceSummary.fileName}</dd>
                  </div>
                  <div>
                    <dt>Notes</dt>
                    <dd>
                      {viewModel.filteredNoteCount.toLocaleString()}
                      {sourceSummary.sourceType === 'audio' ? (
                        <small> / {sourceSummary.totalNoteCount.toLocaleString()}</small>
                      ) : null}
                    </dd>
                  </div>
                  <div>
                    <dt>Range</dt>
                    <dd>
                      {sourcePitchMin}-{sourcePitchMax}
                    </dd>
                  </div>
                  <div>
                    <dt>Length</dt>
                    <dd>{formatSeconds(sourceSummary.duration)}</dd>
                  </div>
                </dl>
                <div className="histogram" aria-label="Source pitch histogram">
                  {histogram.map((value, index) => (
                    <span key={index} style={{ height: `${Math.max(6, value * 100)}%` }} />
                  ))}
                </div>
              </>
            ) : (
              <div className="empty-state">
                <Music2 size={22} />
                <span>No source loaded</span>
              </div>
            )}
          </div>
        </section>

        <section className="panel mapping-panel" aria-label="Mapping">
          <div className="section-heading heading-row">
            <div>
              <SlidersHorizontal size={18} />
              <h2>Downmap</h2>
            </div>
            <button className="icon-button" type="button" onClick={resetRules} title="Reset mapping">
              <RefreshCw size={17} />
            </button>
          </div>

          {sourceSummary ? (
            <div className="source-range-overview" aria-label="Source pitch range overview">
              <div className="range-overview-header">
                <span>Source Pitch Dominion</span>
                <strong>
                  {sourcePitchMin} {midiNoteLabel(sourcePitchMin)} - {sourcePitchMax}{' '}
                  {midiNoteLabel(sourcePitchMax)}
                </strong>
              </div>
              <div className="source-keyboard">
                {histogram.map((value, index) => {
                  const pitch =
                    sourcePitchMin +
                    Math.round((index / Math.max(1, histogram.length - 1)) * sourcePitchSpan);
                  return (
                    <span
                      className={isBlackKey(pitch) ? 'is-black-key' : ''}
                      key={`source-key-${index}`}
                      style={{ height: `${Math.max(8, value * 42)}px` }}
                      title={`Around MIDI ${pitch} ${midiNoteLabel(pitch)}`}
                    />
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="range-empty">Load audio or MIDI to awaken the source range editor.</div>
          )}

          <div className="range-editor">
            {orderedGroups.map(group => {
              const rule = rules.find(item => item.groupId === group.id);
              if (!rule) {
                return null;
              }
              const rangeMin = clampPitch(
                Math.min(rule.sourceMin, rule.sourceMax),
                sourcePitchMin,
                sourcePitchMax,
              );
              const rangeMax = clampPitch(
                Math.max(rule.sourceMin, rule.sourceMax),
                sourcePitchMin,
                sourcePitchMax,
              );
              const rangeLeft = ((rangeMin - sourcePitchMin) / sourcePitchSpan) * 100;
              const rangeWidth = Math.max(1, ((rangeMax - rangeMin) / sourcePitchSpan) * 100);

              return (
                <article
                  className={`range-row ${rule.enabled ? '' : 'is-disabled'}`}
                  key={group.id}
                  style={{ '--group-color': group.color } as React.CSSProperties}
                >
                  <div className="range-row-header">
                    <label className="toggle-row">
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        onChange={event => updateRule(group.id, { enabled: event.target.checked })}
                      />
                      <span className="group-dot" style={{ backgroundColor: group.color }} />
                      <span>{group.topLabel ?? group.label}</span>
                    </label>
                    <div className="range-row-actions">
                      <label className="overlap-toggle">
                        <input
                          type="checkbox"
                          checked={rule.allowOverlap}
                          disabled={!sourceSummary || !rule.enabled}
                          onChange={event =>
                            updateRule(group.id, { allowOverlap: event.target.checked })
                          }
                        />
                        <span>Allow overlap</span>
                      </label>
                      <span className="event-count">{eventsByGroup[group.id] ?? 0}</span>
                    </div>
                  </div>

                  <div className="range-band-shell">
                    <div className="range-keyboard" aria-hidden="true">
                      {histogram.map((value, index) => {
                        const pitch =
                          sourcePitchMin +
                          Math.round((index / Math.max(1, histogram.length - 1)) * sourcePitchSpan);
                        return (
                          <span
                            className={isBlackKey(pitch) ? 'is-black-key' : ''}
                            key={`${group.id}-key-${index}`}
                            style={{ height: `${Math.max(8, value * 42)}px` }}
                          />
                        );
                      })}
                    </div>
                    <span
                      className="range-band"
                      style={
                        {
                          left: `${rangeLeft}%`,
                          width: `${rangeWidth}%`,
                        } as React.CSSProperties
                      }
                    >
                      <span className="range-band-label">{rangeMax - rangeMin + 1} notes</span>
                    </span>
                    <input
                      className="range-handle range-handle-min"
                      type="range"
                      min={sourcePitchMin}
                      max={sourcePitchMax}
                      step={1}
                      value={rangeMin}
                      disabled={!sourceSummary || !rule.enabled}
                      onChange={event =>
                        updateRuleRange(group.id, { sourceMin: Number(event.target.value) })
                      }
                      aria-label={`${group.label} source range low note`}
                    />
                    <input
                      className="range-handle range-handle-max"
                      type="range"
                      min={sourcePitchMin}
                      max={sourcePitchMax}
                      step={1}
                      value={rangeMax}
                      disabled={!sourceSummary || !rule.enabled}
                      onChange={event =>
                        updateRuleRange(group.id, { sourceMax: Number(event.target.value) })
                      }
                      aria-label={`${group.label} source range high note`}
                    />
                  </div>

                  <div className="range-readout">
                    <span>
                      Lower <strong>{rangeMin}</strong> <em>{midiNoteLabel(rangeMin)}</em>
                    </span>
                    <span>
                      Upper <strong>{rangeMax}</strong> <em>{midiNoteLabel(rangeMax)}</em>
                    </span>
                  </div>

                  <div className="target-density" aria-label={`${group.label} target note counts`}>
                    {group.notes.map(note => (
                      <span
                        className={activeTargetNotes.has(note) ? 'is-active' : ''}
                        key={note}
                        style={{ borderColor: group.color }}
                      >
                        <strong>{note}</strong>
                        <em>{midiNoteLabel(note)}</em>
                        <small>{eventsByTargetNote[note] ?? 0}</small>
                      </span>
                    ))}
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <section className="panel export-panel" aria-label="Export">
          <div className="section-heading">
            <Download size={18} />
            <h2>Export</h2>
          </div>

          <div className="export-meter">
            <strong>{viewModel.remappedEventCount.toLocaleString()}</strong>
            <span>lighting MIDI notes</span>
          </div>

          <details className="export-controls-panel">
            <summary>
              <SlidersHorizontal size={16} />
              MIDI control settings
            </summary>
            <div className="export-control-list">
              <label className="export-control-row">
                <span>
                  <strong>Brightness</strong>
                  <em>CC 1 Dimmer</em>
                </span>
                <input
                  type="range"
                  min={0}
                  max={127}
                  step={1}
                  value={exportControls.brightness}
                  onChange={event => updateExportControl('brightness', Number(event.target.value))}
                />
                <output>{exportControls.brightness}</output>
              </label>
              <label className="export-control-row">
                <span>
                  <strong>Colour</strong>
                  <em>CC 2 Preset select</em>
                </span>
                <input
                  type="range"
                  min={0}
                  max={127}
                  step={1}
                  value={exportControls.color}
                  onChange={event => updateExportControl('color', Number(event.target.value))}
                />
                <output>{exportControls.color}</output>
              </label>
              <label className="export-control-row">
                <span>
                  <strong>Lag up</strong>
                  <em>CC 3 transition rise</em>
                </span>
                <input
                  type="range"
                  min={0}
                  max={127}
                  step={1}
                  value={exportControls.lagUp}
                  onChange={event => updateExportControl('lagUp', Number(event.target.value))}
                />
                <output>{exportControls.lagUp}</output>
              </label>
              <label className="export-control-row">
                <span>
                  <strong>Lag down</strong>
                  <em>CC 4 transition fall</em>
                </span>
                <input
                  type="range"
                  min={0}
                  max={127}
                  step={1}
                  value={exportControls.lagDown}
                  onChange={event => updateExportControl('lagDown', Number(event.target.value))}
                />
                <output>{exportControls.lagDown}</output>
              </label>
              <label className="export-control-row">
                <span>
                  <strong>Gobo</strong>
                  <em>CC 5 beam shape</em>
                </span>
                <input
                  type="range"
                  min={0}
                  max={127}
                  step={1}
                  value={exportControls.gobo}
                  onChange={event => updateExportControl('gobo', Number(event.target.value))}
                />
                <output>{exportControls.gobo}</output>
              </label>

              <PhasorControlGroup
                controls={exportControls.headXPhasor}
                label="Head X phasor"
                controllerBase={50}
                onChange={(key, value) => updatePhasorControl('headXPhasor', key, value)}
              />
              <PhasorControlGroup
                controls={exportControls.headYPhasor}
                label="Head Y phasor"
                controllerBase={60}
                onChange={(key, value) => updatePhasorControl('headYPhasor', key, value)}
              />
              <PhasorControlGroup
                controls={exportControls.dimmerPhasor}
                label="Dimmer phasor"
                controllerBase={70}
                onChange={(key, value) => updatePhasorControl('dimmerPhasor', key, value)}
              />
            </div>
          </details>

          <div className="browser-midi-panel">
            <label className="browser-midi-toggle">
              <input
                type="checkbox"
                checked={browserMidiEnabled}
                onChange={event => setBrowserMidiEnabled(event.target.checked)}
              />
              <span>
                <strong>Live note output (preview mode)</strong>
                <em>Browser MIDI channel 1</em>
              </span>
            </label>

            <label className="browser-midi-select">
              <span>Output device</span>
              <select
                disabled={!browserMidiEnabled || browserMidiOutputs.length === 0}
                value={selectedBrowserMidiOutputId}
                onChange={event => setSelectedBrowserMidiOutputId(event.target.value)}
              >
                {browserMidiOutputs.length > 0 ? (
                  browserMidiOutputs.map(output => (
                    <option key={output.id} value={output.id}>
                      {output.label}
                    </option>
                  ))
                ) : (
                  <option value="">
                    {browserMidiEnabled ? 'No outputs found' : 'Enable to scan outputs'}
                  </option>
                )}
              </select>
            </label>

            <div className="browser-midi-debug" aria-label="Live MIDI output debug">
              <span>
                <strong>Device</strong>
                <em>{getSelectedBrowserMidiOutputLabel()}</em>
              </span>
              <span>
                <strong>Active</strong>
                <em>{browserMidiDebug.activeNoteCount} notes</em>
              </span>
              <span>
                <strong>Init</strong>
                <em>{browserMidiDebug.controlCount} messages</em>
              </span>
              <span>
                <strong>Last</strong>
                <em>{browserMidiDebug.lastEvent}</em>
              </span>
            </div>

            <button
              className="browser-midi-panic"
              type="button"
              disabled={!browserMidiEnabled || !browserMidiOutputRef.current}
              onClick={sendBrowserMidiAllNotesOff}
            >
              <RefreshCw size={15} />
              Send all notes off
            </button>

            <p className="browser-midi-status">{browserMidiStatus}</p>
          </div>

          <button
            className="primary-action"
            type="button"
            disabled={!sourceSummary || isBusy || viewModel.remappedEventCount === 0}
            onClick={exportMidi}
          >
            <Download size={18} />
            Export MIDI
          </button>

          {exportedMidi ? (
            <p className="export-ready">{exportedMidi.fileName}</p>
          ) : null}

          <button
            className="secondary-action"
            type="button"
            disabled={!sourceAudioDownload}
            onClick={exportAudio}
          >
            <FileMusic size={18} />
            Export Audio
          </button>

        </section>
      </div>
    </main>
  );
}

function PhasorControlGroup({
  controllerBase,
  controls,
  label,
  onChange,
}: {
  controllerBase: number;
  controls: PhasorControls;
  label: string;
  onChange: (key: keyof PhasorControls, value: number) => void;
}) {
  return (
    <div className="phasor-control-group">
      <h3>{label}</h3>
      <label className="export-control-row">
        <span>
          <strong>Min</strong>
          <em>CC {controllerBase + 1}</em>
        </span>
        <input
          type="range"
          min={0}
          max={127}
          step={1}
          value={controls.min}
          onChange={event => onChange('min', Number(event.target.value))}
        />
        <output>{controls.min}</output>
      </label>
      <label className="export-control-row">
        <span>
          <strong>Max</strong>
          <em>CC {controllerBase + 2}</em>
        </span>
        <input
          type="range"
          min={0}
          max={127}
          step={1}
          value={controls.max}
          onChange={event => onChange('max', Number(event.target.value))}
        />
        <output>{controls.max}</output>
      </label>
      <label className="export-control-row">
        <span>
          <strong>Speed</strong>
          <em>CC {controllerBase + 3}</em>
        </span>
        <input
          type="range"
          min={0}
          max={127}
          step={1}
          value={controls.speed}
          onChange={event => onChange('speed', Number(event.target.value))}
        />
        <output>{controls.speed}</output>
      </label>
      <label className="export-control-row export-control-row-waveform">
        <span>
          <strong>Waveform</strong>
          <em>CC {controllerBase + 4}</em>
        </span>
        <input
          type="range"
          min={0}
          max={127}
          step="any"
          value={controls.waveform}
          onChange={event => onChange('waveform', Number(event.target.value))}
        />
        <output>{Math.round(controls.waveform)}</output>
      </label>
    </div>
  );
}

function TimelineAutomationEditor({
  automation,
  duration,
  lanes,
  playbackTime,
  setAutomation,
}: {
  automation: TimelineAutomation;
  duration: number;
  lanes: AutomationLane[];
  playbackTime: number;
  setAutomation: React.Dispatch<React.SetStateAction<TimelineAutomation>>;
}) {
  const [dragState, setDragState] = useState<AutomationDragState | null>(null);
  const safeDuration = Math.max(AUTOMATION_MIN_BLOCK_SECONDS, duration);

  useEffect(() => {
    if (!dragState) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      event.preventDefault();
      const deltaSeconds = ((event.clientX - dragState.pointerStartX) / dragState.trackWidth) * safeDuration;
      let nextStart = dragState.originalStart;
      let nextEnd = dragState.originalEnd;

      if (dragState.mode === 'move') {
        const blockDuration = dragState.originalEnd - dragState.originalStart;
        nextStart = dragState.originalStart + deltaSeconds;
        nextEnd = nextStart + blockDuration;

        if (nextStart < 0) {
          nextStart = 0;
          nextEnd = blockDuration;
        }

        if (nextEnd > dragState.duration) {
          nextEnd = dragState.duration;
          nextStart = Math.max(0, nextEnd - blockDuration);
        }
      } else if (dragState.mode === 'start') {
        nextStart = Math.min(dragState.originalStart + deltaSeconds, dragState.originalEnd - AUTOMATION_MIN_BLOCK_SECONDS);
      } else {
        nextEnd = Math.max(dragState.originalEnd + deltaSeconds, dragState.originalStart + AUTOMATION_MIN_BLOCK_SECONDS);
      }

      const range = normalizeAutomationBlockRange(nextStart, nextEnd, dragState.duration);
      setAutomation(current => ({
        ...current,
        [dragState.laneId]: sortAutomationBlocks(
          current[dragState.laneId].map(block =>
            block.id === dragState.blockId
              ? {
                  ...block,
                  start: range.start,
                  end: range.end,
                }
              : block,
          ),
        ),
      }));
    };

    const handlePointerUp = () => setDragState(null);

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [dragState, safeDuration, setAutomation]);

  function addBlock(laneId: AutomationLaneId) {
    const start = clampAutomationTime(snapAutomationTime(playbackTime), safeDuration);
    const end = Math.min(safeDuration, start + Math.min(4, safeDuration));
    const range = normalizeAutomationBlockRange(start, end, safeDuration);

    setAutomation(current => ({
      ...current,
      [laneId]: sortAutomationBlocks([
        ...current[laneId],
        {
          id: `block-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          start: range.start,
          end: range.end,
        },
      ]),
    }));
  }

  function enableFullSong(laneId: AutomationLaneId) {
    setAutomation(current => ({
      ...current,
      [laneId]: [
        {
          id: 'full-song',
          start: 0,
          end: safeDuration,
        },
      ],
    }));
  }

  function clearLane(laneId: AutomationLaneId) {
    setAutomation(current => ({
      ...current,
      [laneId]: [],
    }));
  }

  function startDrag(
    event: React.PointerEvent<HTMLElement>,
    laneId: AutomationLaneId,
    block: AutomationBlock,
    mode: AutomationDragState['mode'],
  ) {
    const track = event.currentTarget.closest('.automation-lane-track');
    const trackWidth = track?.getBoundingClientRect().width ?? 1;
    event.preventDefault();
    event.stopPropagation();

    setDragState({
      blockId: block.id,
      duration: safeDuration,
      laneId,
      mode,
      originalEnd: block.end,
      originalStart: block.start,
      pointerStartX: event.clientX,
      trackWidth: Math.max(1, trackWidth),
    });
  }

  return (
    <div className="automation-editor">
      <div className="automation-editor-heading">
        <span>Enabled blocks export as CC 127; empty space exports as CC 0.</span>
        <em>{formatSeconds(safeDuration)} timeline</em>
      </div>

      {lanes.map(lane => {
        const blocks = automation[lane.id] ?? [];
        return (
          <div className="automation-lane" key={lane.id}>
            <div className="automation-lane-label">
              <strong>{lane.shortLabel}</strong>
              <span>{lane.label}</span>
              <em>CC {lane.controller}</em>
            </div>
            <div
              className="automation-lane-track"
              style={{ '--lane-color': lane.color } as React.CSSProperties}
            >
              {blocks.map(block => {
                const left = `${(block.start / safeDuration) * 100}%`;
                const width = `${Math.max(0.5, ((block.end - block.start) / safeDuration) * 100)}%`;
                return (
                  <div
                    className="automation-block"
                    key={block.id}
                    onPointerDown={event => startDrag(event, lane.id, block, 'move')}
                    style={{ left, width }}
                    title={`${formatSeconds(block.start)} - ${formatSeconds(block.end)}`}
                  >
                    <span
                      className="automation-block-handle automation-block-handle-start"
                      onPointerDown={event => startDrag(event, lane.id, block, 'start')}
                    />
                    <small>
                      {formatSeconds(block.start)} - {formatSeconds(block.end)}
                    </small>
                    <span
                      className="automation-block-handle automation-block-handle-end"
                      onPointerDown={event => startDrag(event, lane.id, block, 'end')}
                    />
                  </div>
                );
              })}
            </div>
            <div className="automation-lane-actions">
              <button type="button" onClick={() => addBlock(lane.id)} disabled={duration <= 0}>
                Add block
              </button>
              <button type="button" onClick={() => enableFullSong(lane.id)} disabled={duration <= 0}>
                Enable full song
              </button>
              <button type="button" onClick={() => clearLane(lane.id)}>
                Clear
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TimelineCanvas({
  activeWindowsByTargetNote,
  duration,
  eventsByTargetNote,
  groups,
  isPlaying,
  onHoverNote,
  playbackTime,
  playbackTimeRef,
  setZoom,
  timelineBinsByTargetNote,
  zoom,
}: {
  activeWindowsByTargetNote: PipelineViewModel['activeWindowsByTargetNote'];
  duration: number;
  eventsByTargetNote: Record<number, number>;
  groups: LightingGroup[];
  isPlaying: boolean;
  onHoverNote: (note: { groupLabel: string; note: number; count: number } | null) => void;
  playbackTime: number;
  playbackTimeRef: React.MutableRefObject<number>;
  setZoom: React.Dispatch<React.SetStateAction<number>>;
  timelineBinsByTargetNote: PipelineViewModel['timelineBinsByTargetNote'];
  zoom: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hoverNoteRef = useRef<number | null>(null);
  const rowsRef = useRef<
    Array<{
      color: string;
      groupLabel: string;
      groupShortLabel: string;
      groupStart: boolean;
      note: number;
      y: number;
    }>
  >([]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    const width = Math.max(320, Math.floor(rect.width));
    const rowHeight = width < 600 ? 18 : 20;
    const rowGap = 3;
    const groupGap = 7;
    const padding = 10;
    const groupLabelWidth = width < 700 ? 72 : 98;
    const noteLabelWidth = width < 700 ? 48 : 56;
    const rows = flattenTimelineRows(groups, rowHeight, rowGap, groupGap, padding);
    const height =
      rows.length === 0
        ? 120
        : rows[rows.length - 1].y + rowHeight + padding;

    if (canvas.width !== Math.floor(width * scale) || canvas.height !== Math.floor(height * scale)) {
      canvas.width = Math.floor(width * scale);
      canvas.height = Math.floor(height * scale);
      canvas.style.height = `${height}px`;
    }

    rowsRef.current = rows;

    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }

    const stage = canvas.parentElement;
    const viewportStartX = Math.max(0, (stage?.scrollLeft ?? 0) - canvas.offsetLeft - 160);
    const viewportEndX = viewportStartX + (stage?.clientWidth ?? width) + 320;

    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#12050e';
    context.fillRect(0, 0, width, height);

    const trackX = padding + groupLabelWidth + noteLabelWidth + 12;
    const trackWidth = Math.max(80, width - trackX - padding);
    const safeDuration = Math.max(0.01, duration);
    const playbackRatio = Math.max(0, Math.min(1, playbackTimeRef.current / safeDuration));
    const hoveredNote = hoverNoteRef.current;
    const headingFont = getCanvasFont('--font-heading');
    const bodyFont = getCanvasFont('--font-body');

    context.strokeStyle = 'rgba(244, 198, 79, 0.16)';
    context.lineWidth = 1;
    for (let index = 0; index <= 10; index += 1) {
      const x = trackX + (trackWidth * index) / 10;
      context.beginPath();
      context.moveTo(x, padding);
      context.lineTo(x, height - padding);
      context.stroke();
    }

    rows.forEach(row => {
      const active = isTimeInWindows(playbackTimeRef.current, activeWindowsByTargetNote[row.note] ?? []);
      const hovered = hoveredNote === row.note;
      const fill = hexToRgb(row.color);

      if (row.groupStart) {
        context.fillStyle = 'rgba(255, 243, 207, 0.9)';
        context.font = `700 11px ${headingFont}`;
        context.textBaseline = 'middle';
        context.fillText(row.groupShortLabel, padding, row.y + rowHeight / 2);
      }

      context.fillStyle = active
        ? `rgba(${fill.r}, ${fill.g}, ${fill.b}, 0.24)`
        : hovered
          ? 'rgba(244, 198, 79, 0.13)'
          : 'rgba(255, 255, 255, 0.035)';
      roundRect(context, padding + groupLabelWidth, row.y, width - padding - groupLabelWidth, rowHeight, 6);
      context.fill();

      context.strokeStyle = active
        ? 'rgba(255, 243, 207, 0.64)'
        : `rgba(${fill.r}, ${fill.g}, ${fill.b}, 0.2)`;
      context.stroke();

      context.fillStyle = '#fff7d5';
      context.font = `700 11px ${bodyFont}`;
      context.textBaseline = 'middle';
      context.fillText(String(row.note), padding + groupLabelWidth + 7, row.y + rowHeight / 2);
      context.fillStyle = 'rgba(255, 243, 207, 0.66)';
      context.font = `10px ${bodyFont}`;
      context.fillText(midiNoteLabel(row.note), padding + groupLabelWidth + 25, row.y + rowHeight / 2);

      context.fillStyle = 'rgba(255, 255, 255, 0.035)';
      roundRect(context, trackX, row.y + 3, trackWidth, rowHeight - 6, 5);
      context.fill();

      const bins = timelineBinsByTargetNote[row.note] ?? [];
      const maxBinCount = bins.reduce((max, bin) => Math.max(max, bin.count), 1);
      bins.forEach(bin => {
        const density = Math.min(1, bin.count / maxBinCount);
        const x = trackX + bin.startRatio * trackWidth;
        const rawWidth = Math.max(1, (bin.endRatio - bin.startRatio) * trackWidth);
        if (x > viewportEndX || x + rawWidth < viewportStartX) {
          return;
        }

        const gap = Math.min(2.8, Math.max(0.45, rawWidth * 0.22));
        const binWidth = Math.max(1, rawWidth - gap);
        const binHeight = Math.max(4, Math.min(rowHeight - 5, 4 + density * (rowHeight - 8)));
        const y = row.y + (rowHeight - binHeight) / 2;
        const alpha = 0.34 + density * 0.46;
        context.fillStyle = `rgba(${fill.r}, ${fill.g}, ${fill.b}, ${alpha})`;
        if (binWidth < 2.5) {
          context.fillRect(x + gap / 2, y, binWidth, binHeight);
        } else {
          roundRect(context, x + gap / 2, y, binWidth, binHeight, Math.min(5, binHeight / 2));
          context.fill();
        }
      });

      if (active) {
        context.shadowColor = row.color;
        context.shadowBlur = 14;
        context.strokeStyle = `rgba(${fill.r}, ${fill.g}, ${fill.b}, 0.9)`;
        context.lineWidth = 2;
        roundRect(context, trackX, row.y + 2, trackWidth, rowHeight - 4, 5);
        context.stroke();
        context.shadowBlur = 0;
        context.lineWidth = 1;
      }
    });

    const playheadX = trackX + playbackRatio * trackWidth;
    context.strokeStyle = '#fff2a8';
    context.lineWidth = 2;
    context.shadowColor = '#fff2a8';
    context.shadowBlur = 12;
    context.beginPath();
    context.moveTo(playheadX, padding);
    context.lineTo(playheadX, height - padding);
    context.stroke();
    context.shadowBlur = 0;
  }, [activeWindowsByTargetNote, duration, groups, playbackTimeRef, timelineBinsByTargetNote]);

  const centerOnPlayhead = useCallback(() => {
    const canvas = canvasRef.current;
    const stage = canvas?.parentElement;
    if (!canvas || !stage) {
      return;
    }

    const width = Math.max(320, Math.floor(canvas.getBoundingClientRect().width));
    const padding = 10;
    const groupLabelWidth = width < 700 ? 72 : 98;
    const noteLabelWidth = width < 700 ? 48 : 56;
    const trackX = padding + groupLabelWidth + noteLabelWidth + 12;
    const trackWidth = Math.max(80, width - trackX - padding);
    const playbackRatio = Math.max(0, Math.min(1, playbackTimeRef.current / Math.max(0.01, duration)));
    const playheadX = trackX + playbackRatio * trackWidth;
    const maxScroll = Math.max(0, stage.scrollWidth - stage.clientWidth);
    const nextScroll = Math.max(0, Math.min(maxScroll, playheadX - stage.clientWidth / 2));

    stage.scrollLeft = nextScroll;
  }, [duration, playbackTimeRef]);

  useEffect(() => {
    let animationFrame = 0;

    const render = () => {
      draw();
      if (isPlaying) {
        centerOnPlayhead();
      }
      if (isPlaying) {
        animationFrame = window.requestAnimationFrame(render);
      }
    };

    render();

    return () => {
      if (animationFrame) {
        window.cancelAnimationFrame(animationFrame);
      }
    };
  }, [centerOnPlayhead, draw, isPlaying]);

  useEffect(() => {
    const resizeObserver = new ResizeObserver(() => draw());
    if (canvasRef.current) {
      resizeObserver.observe(canvasRef.current);
    }
    return () => resizeObserver.disconnect();
  }, [draw]);

  useEffect(() => {
    draw();
    window.requestAnimationFrame(centerOnPlayhead);
  }, [centerOnPlayhead, draw, playbackTime, zoom]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = canvas?.parentElement;
    if (!stage) {
      return;
    }

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const dominantDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      const delta = dominantDelta < 0 ? 1.14 : 1 / 1.14;
      setZoom(currentZoom => Math.max(1, Math.min(12, Number((currentZoom * delta).toFixed(3)))));
    };

    stage.addEventListener('wheel', handleWheel, { passive: false });

    return () => stage.removeEventListener('wheel', handleWheel);
  }, [setZoom]);


  function handleMouseMove(event: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const y = event.clientY - rect.top;
    const row = rowsRef.current.find(candidate => y >= candidate.y && y <= candidate.y + 22);
    const nextNote = row?.note ?? null;
    if (hoverNoteRef.current === nextNote) {
      return;
    }

    hoverNoteRef.current = nextNote;
    onHoverNote(
      row
        ? {
            groupLabel: row.groupLabel,
            note: row.note,
            count: eventsByTargetNote[row.note] ?? 0,
          }
        : null,
    );
    draw();
  }

  function handleMouseLeave() {
    hoverNoteRef.current = null;
    onHoverNote(null);
    draw();
  }

  return (
    <canvas
      ref={canvasRef}
      className="timeline-canvas"
      style={{ width: `${Math.max(1, zoom) * 100}%` }}
      onMouseLeave={handleMouseLeave}
      onMouseMove={handleMouseMove}
      aria-label="Canvas MIDI timeline with all target note rows"
    />
  );
}

function flattenTimelineRows(
  groups: LightingGroup[],
  rowHeight: number,
  rowGap: number,
  groupGap: number,
  padding: number,
) {
  let y = padding;
  return groups.flatMap(group => {
    const rows = group.notes.map((note, index) => {
      const row = {
        color: group.color,
        groupLabel: group.label,
        groupShortLabel: group.shortLabel,
        groupStart: index === 0,
        note,
        y,
      };
      y += rowHeight + rowGap;
      return row;
    });
    y += groupGap;
    return rows;
  });
}

function createDefaultRulesFromSummary(summary: SourceSummary | null): MappingRule[] {
  if (!summary) {
    return createDefaultRules(null, lightingConfig);
  }

  return createDefaultRules(
    {
      fileName: summary.fileName,
      sourceType: summary.sourceType,
      duration: summary.duration,
      notes: [],
      tracks: summary.tracks,
      minMidi: summary.filteredMinMidi,
      maxMidi: summary.filteredMaxMidi,
    },
    lightingConfig,
  );
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const normalized = hex.replace('#', '');
  const value =
    normalized.length === 3
      ? normalized
          .split('')
          .map(character => `${character}${character}`)
          .join('')
      : normalized.padEnd(6, '0').slice(0, 6);
  const numeric = Number.parseInt(value, 16);

  return {
    r: (numeric >> 16) & 255,
    g: (numeric >> 8) & 255,
    b: numeric & 255,
  };
}

function getCanvasFont(variableName: string): string {
  if (typeof window === 'undefined') {
    return 'Georgia, serif';
  }

  return (
    window
      .getComputedStyle(document.documentElement)
      .getPropertyValue(variableName)
      .trim() || 'Georgia, serif'
  );
}

function roundRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.lineTo(x + width - safeRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  context.lineTo(x + width, y + height - safeRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  context.lineTo(x + safeRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  context.lineTo(x, y + safeRadius);
  context.quadraticCurveTo(x, y, x + safeRadius, y);
  context.closePath();
}

function isBlackKey(note: number): boolean {
  return [1, 3, 6, 8, 10].includes(note % 12);
}

function clampPitch(value: number, min: number, max: number): number {
  const safeValue = Number.isFinite(value) ? Math.round(value) : min;
  return Math.max(min, Math.min(max, safeValue));
}

function clampPitchBendValue(value: number): number {
  const safeValue = Number.isFinite(value) ? Math.round(value) : 8192;
  return Math.max(0, Math.min(16383, safeValue));
}

function getBrowserMidiOutputLabel(output: MIDIOutput): string {
  const parts = [output.manufacturer, output.name ?? output.id].filter(Boolean);
  return (parts.join(' ') || output.id).replace(/^microsoft corporation\s+/i, '');
}

function readStoredAppSession(): StoredAppSession | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const rawValue = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!rawValue) {
      return null;
    }

    const parsed = JSON.parse(rawValue) as Partial<StoredAppSession>;
    if (parsed.version !== 1) {
      return null;
    }

    return {
      audio: isStoredSessionAudio(parsed.audio) ? parsed.audio : null,
      confidenceFloor:
        typeof parsed.confidenceFloor === 'number'
          ? parsed.confidenceFloor
          : DEFAULT_AUDIO_CONFIDENCE_FLOOR,
      exportControls: mergeExportControls(parsed.exportControls),
      isAutomationOpen: Boolean(parsed.isAutomationOpen),
      rules: Array.isArray(parsed.rules) ? parsed.rules : createDefaultRules(null, lightingConfig),
      selectedBrowserMidiOutputId:
        typeof parsed.selectedBrowserMidiOutputId === 'string'
          ? parsed.selectedBrowserMidiOutputId
          : '',
      source: isStoredSessionSource(parsed.source) ? parsed.source : null,
      timelineAutomation: mergeTimelineAutomation(parsed.timelineAutomation),
      timelineZoom:
        typeof parsed.timelineZoom === 'number'
          ? Math.max(1, Math.min(12, parsed.timelineZoom))
          : 1,
      version: 1,
    };
  } catch (error) {
    console.warn('Could not read NICS session storage.', error);
    return null;
  }
}

function writeStoredAppSession(session: StoredAppSession) {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch (error) {
    try {
      window.sessionStorage.setItem(
        SESSION_STORAGE_KEY,
        JSON.stringify({
          ...session,
          source: null,
        }),
      );
      console.warn('NICS session source was too large to store; saved controls and audio reference only.', error);
    } catch (fallbackError) {
      console.warn('Could not write NICS session storage.', fallbackError);
    }
  }
}

function restoreStoredSource(worker: Worker, source: StoredSessionSource) {
  if (source.kind === 'midi') {
    const arrayBuffer = base64ToArrayBuffer(source.base64);
    worker.postMessage(
      {
        type: 'load-midi',
        fileName: source.fileName,
        arrayBuffer,
      },
      [arrayBuffer],
    );
    return;
  }

  worker.postMessage({
    type: 'load-basic-pitch',
    fileName: source.fileName,
    notes: source.notes,
  });
}

function isStoredSessionSource(value: unknown): value is StoredSessionSource {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<StoredSessionSource>;
  if (candidate.kind === 'midi') {
    return typeof candidate.fileName === 'string' && typeof candidate.base64 === 'string';
  }

  return (
    candidate.kind === 'basic-pitch' &&
    typeof candidate.fileName === 'string' &&
    Array.isArray(candidate.notes)
  );
}

function isStoredSessionAudio(value: unknown): value is StoredSessionAudio {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<StoredSessionAudio>;
  return (
    typeof candidate.fileName === 'string' &&
    typeof candidate.mimeType === 'string' &&
    typeof candidate.storageKey === 'string'
  );
}

async function fileToStoredAudio(file: File): Promise<StoredSessionAudio> {
  const storageKey = SESSION_AUDIO_STORAGE_KEY;
  await putStoredAudioBlob(storageKey, file);

  return {
    fileName: file.name,
    mimeType: file.type || 'audio/mpeg',
    storageKey,
  };
}

async function createStoredAudioSafely(file: File): Promise<StoredSessionAudio | null> {
  try {
    return await fileToStoredAudio(file);
  } catch (error) {
    console.warn('Could not store audio for reload restore.', error);
    return null;
  }
}

async function restoreStoredAudio(audio: StoredSessionAudio): Promise<SourceAudioDownload> {
  const blob = await getStoredAudioBlob(audio.storageKey);
  if (!blob) {
    throw new Error('No stored audio blob was found.');
  }

  return {
    fileName: audio.fileName,
    url: URL.createObjectURL(blob),
  };
}

function mergeExportControls(value: unknown): ExportMidiControls {
  const candidate = value && typeof value === 'object' ? (value as Partial<ExportMidiControls>) : {};
  return {
    ...DEFAULT_EXPORT_CONTROLS,
    ...candidate,
    brightness: clampMidiControl(Number(candidate.brightness ?? DEFAULT_EXPORT_CONTROLS.brightness)),
    color: clampMidiControl(Number(candidate.color ?? DEFAULT_EXPORT_CONTROLS.color)),
    lagUp: clampMidiControl(Number(candidate.lagUp ?? DEFAULT_EXPORT_CONTROLS.lagUp)),
    lagDown: clampMidiControl(Number(candidate.lagDown ?? DEFAULT_EXPORT_CONTROLS.lagDown)),
    gobo: clampMidiControl(Number(candidate.gobo ?? DEFAULT_EXPORT_CONTROLS.gobo)),
    headXPhasor: mergePhasorControls(candidate.headXPhasor, DEFAULT_EXPORT_CONTROLS.headXPhasor),
    headYPhasor: mergePhasorControls(candidate.headYPhasor, DEFAULT_EXPORT_CONTROLS.headYPhasor),
    dimmerPhasor: mergePhasorControls(candidate.dimmerPhasor, DEFAULT_EXPORT_CONTROLS.dimmerPhasor),
  };
}

function mergePhasorControls(value: unknown, fallback: PhasorControls): PhasorControls {
  const candidate = value && typeof value === 'object' ? (value as Partial<PhasorControls>) : {};
  return {
    min: clampMidiControl(Number(candidate.min ?? fallback.min)),
    max: clampMidiControl(Number(candidate.max ?? fallback.max)),
    speed: clampMidiControl(Number(candidate.speed ?? fallback.speed)),
    waveform: normalizeWaveformControl((candidate as Record<string, unknown>).waveform ?? fallback.waveform),
  };
}

function normalizeWaveformControl(value: unknown): number {
  if (typeof value === 'string') {
    const legacyValues: Record<string, number> = {
      sine: 0,
      triangle: 42,
      square: 85,
      saw: 127,
    };
    return legacyValues[value] ?? 0;
  }

  return clampMidiControl(Number(value));
}

function mergeTimelineAutomation(value: unknown): TimelineAutomation {
  const defaults = createDefaultTimelineAutomation(0);
  const candidate = value && typeof value === 'object' ? value as Partial<TimelineAutomation> : {};

  return Object.keys(defaults).reduce<TimelineAutomation>((automation, laneId) => {
    const lane = laneId as AutomationLaneId;
    const blocks = candidate[lane];
    automation[lane] = Array.isArray(blocks)
      ? blocks
          .filter(block => typeof block.start === 'number' && typeof block.end === 'number')
          .map((block, index) => ({
            id: typeof block.id === 'string' ? block.id : `${lane}-stored-${index}`,
            start: Math.max(0, block.start),
            end: Math.max(0, block.end),
          }))
      : defaults[lane];
    return automation;
  }, {} as TimelineAutomation);
}

function openSessionAudioDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(SESSION_AUDIO_DB_NAME, 1);

    request.onupgradeneeded = () => {
      request.result.createObjectStore(SESSION_AUDIO_STORE_NAME);
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open audio storage.'));
    request.onsuccess = () => resolve(request.result);
  });
}

async function putStoredAudioBlob(storageKey: string, blob: Blob) {
  const database = await openSessionAudioDb();

  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(SESSION_AUDIO_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(SESSION_AUDIO_STORE_NAME);
    const request = store.put(blob, storageKey);

    request.onerror = () => reject(request.error ?? new Error('Could not store audio blob.'));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not store audio blob.'));
  });

  database.close();
}

async function getStoredAudioBlob(storageKey: string): Promise<Blob | null> {
  const database = await openSessionAudioDb();

  const blob = await new Promise<Blob | null>((resolve, reject) => {
    const transaction = database.transaction(SESSION_AUDIO_STORE_NAME, 'readonly');
    const store = transaction.objectStore(SESSION_AUDIO_STORE_NAME);
    const request = store.get(storageKey);

    request.onerror = () => reject(request.error ?? new Error('Could not read audio blob.'));
    request.onsuccess = () => resolve(request.result instanceof Blob ? request.result : null);
  });

  database.close();
  return blob;
}

function arrayBufferToBase64(arrayBuffer: ArrayBuffer): string {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return window.btoa(binary);
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes.buffer;
}

function createDefaultTimelineAutomation(duration: number): TimelineAutomation {
  const safeDuration = Math.max(0, duration);
  const fixtureBlock = safeDuration > 0 ? [{ id: 'full-song', start: 0, end: safeDuration }] : [];

  return {
    'fixture-strobe': fixtureBlock.map(block => ({ ...block })),
    'fixture-pixelBars': fixtureBlock.map(block => ({ ...block })),
    'fixture-smallMovingHeads': fixtureBlock.map(block => ({ ...block })),
    'fixture-parcans': fixtureBlock.map(block => ({ ...block })),
    'fixture-bigMovingHeads': fixtureBlock.map(block => ({ ...block })),
    'phasor-headX': [],
    'phasor-headY': [],
    'phasor-dimmer': [],
  };
}

function getAutomationControlValuesAtTime(
  automation: TimelineAutomation,
  time: number,
): Record<number, number> {
  return Object.entries(AUTOMATION_CC_BY_LANE).reduce<Record<number, number>>(
    (values, [laneId, controller]) => {
      const blocks = automation[laneId as AutomationLaneId] ?? [];
      values[controller] = blocks.some(block => time >= block.start && time < block.end) ? 127 : 0;
      return values;
    },
    {},
  );
}

function clampAutomationTime(value: number, duration: number): number {
  const safeDuration = Math.max(0, duration);
  const safeValue = Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(safeDuration, safeValue));
}

function snapAutomationTime(value: number): number {
  return Number((Math.round(value / AUTOMATION_SNAP_SECONDS) * AUTOMATION_SNAP_SECONDS).toFixed(3));
}

function normalizeAutomationBlockRange(start: number, end: number, duration: number) {
  const safeDuration = Math.max(AUTOMATION_MIN_BLOCK_SECONDS, duration);
  const nextStart = clampAutomationTime(snapAutomationTime(start), safeDuration);
  const nextEnd = clampAutomationTime(snapAutomationTime(end), safeDuration);

  if (nextEnd - nextStart >= AUTOMATION_MIN_BLOCK_SECONDS) {
    return {
      start: nextStart,
      end: nextEnd,
    };
  }

  if (nextStart >= safeDuration - AUTOMATION_MIN_BLOCK_SECONDS) {
    return {
      start: Math.max(0, safeDuration - AUTOMATION_MIN_BLOCK_SECONDS),
      end: safeDuration,
    };
  }

  return {
    start: nextStart,
    end: Math.min(safeDuration, nextStart + AUTOMATION_MIN_BLOCK_SECONDS),
  };
}

function sortAutomationBlocks(blocks: AutomationBlock[]): AutomationBlock[] {
  return [...blocks].sort((left, right) => left.start - right.start || left.end - right.end);
}

function getPreferredBrowserMidiOutputId(
  outputs: BrowserMidiOutputOption[],
  selectedOutputId: string,
): string {
  if (selectedOutputId && outputs.some(output => output.id === selectedOutputId)) {
    return selectedOutputId;
  }

  return (
    outputs.find(output => output.label.toLowerCase().includes('loop'))?.id ??
    outputs[0]?.id ??
    ''
  );
}

function isTimeInWindows(time: number, windows: Array<[number, number]>): boolean {
  let low = 0;
  let high = windows.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const [start, end] = windows[middle];

    if (time < start) {
      high = middle - 1;
    } else if (time > end) {
      low = middle + 1;
    } else {
      return true;
    }
  }

  return false;
}
