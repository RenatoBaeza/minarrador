// The AudioWorklet global scope. TypeScript ships no lib for it, and the DOM
// lib would claim a `window` and a `document` the audio thread does not have,
// so the four things the worklet actually uses are declared here by hand.

interface AudioWorkletProcessor {
  readonly port: MessagePort;
}

// eslint-disable-next-line no-var
declare var AudioWorkletProcessor: {
  prototype: AudioWorkletProcessor;
  new (options?: unknown): AudioWorkletProcessor;
};

/** The worklet thread's end of the node's message channel. */
interface MessagePort {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: unknown) => AudioWorkletProcessor & {
    process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
  },
): void;

declare const currentTime: number;
declare const sampleRate: number;
