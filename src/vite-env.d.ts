/// <reference types="vite/client" />

interface MIDIOutput {
  id: string;
  connection?: string;
  manufacturer?: string;
  name?: string;
  state?: string;
  send(data: number[], timestamp?: number): void;
}

interface MIDIAccess {
  onstatechange?: (() => void) | null;
  outputs: Map<string, MIDIOutput>;
}

interface Navigator {
  requestMIDIAccess?: (options?: { sysex?: boolean }) => Promise<MIDIAccess>;
}
