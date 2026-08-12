// Runs on the audio thread. Converts the recorded float stream to 16-bit PCM
// and ships it to the main thread in ~256 ms batches, while continuously
// reporting a level so the app can notice a meeting starting.
//
// Its input is always two channels — left is the microphone, right is system
// audio — because the graph in capture.js keeps the two sources apart. What
// comes out is either both channels interleaved, or the two summed to one,
// depending on what the main process asked for when the recording started.
// Main owns that decision because main owns the file: a WAV header is written
// once, and the layout it declares has to hold for the whole meeting.

const BATCH_FRAMES = 4096; // at 16 kHz => 256 ms
const LEVEL_INTERVAL_FRAMES = 1600; // ~100 ms

/** Float sample to 16-bit, clamping so loud passages saturate instead of wrapping. */
const toInt16 = (s) => Math.round((s > 1 ? 1 : s < -1 ? -1 : s) * 32767);

class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    /** 1 = the two sources summed, 2 = mic left, system right. */
    this.channels = 1;
    this.batch = new Int16Array(BATCH_FRAMES * 2);
    this.batchLen = 0;
    this.levelSum = 0;
    this.levelCount = 0;
    this.levelPeak = 0;

    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg?.type === 'record') {
        // Flush whatever is buffered so a stop does not clip the tail.
        if (this.recording && !msg.value) this.flush();
        this.recording = Boolean(msg.value);
        // The layout only ever changes between recordings, so adopting it here
        // cannot reinterleave a file that is already being written.
        if (msg.channels === 1 || msg.channels === 2) this.channels = msg.channels;
        this.batchLen = 0;
      }
    };
  }

  flush() {
    if (this.batchLen === 0) return;
    const out = this.batch.slice(0, this.batchLen);
    this.port.postMessage({ type: 'pcm', buffer: out.buffer }, [out.buffer]);
    this.batchLen = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const left = input && input[0];
    if (!left) return true;
    // A graph that lost one source still delivers a silent channel, but a
    // single-channel input is possible while the graph is being rebuilt.
    const right = (input.length > 1 && input[1]) || left;

    // One batch is BATCH_FRAMES frames however many channels each holds, so a
    // stereo batch is the same 256 ms of meeting as a mono one.
    const capacity = BATCH_FRAMES * this.channels;

    for (let i = 0; i < left.length; i++) {
      const l = left[i];
      const r = right[i];
      // Level is reported on the mix, which is what "was anything audible"
      // means regardless of how the file is being written.
      const mixed = (l + r) / 2;
      const a = mixed < 0 ? -mixed : mixed;
      this.levelSum += mixed * mixed;
      if (a > this.levelPeak) this.levelPeak = a;
      this.levelCount++;

      if (this.recording) {
        if (this.channels === 2) {
          this.batch[this.batchLen++] = toInt16(l);
          this.batch[this.batchLen++] = toInt16(r);
        } else {
          // Mono is only asked for when a single source is live, so the sum is
          // that source at full gain; the clamp bounds the case where a status
          // race means both were.
          this.batch[this.batchLen++] = toInt16(l + r);
        }
        if (this.batchLen >= capacity) this.flush();
      }
    }

    if (this.levelCount >= LEVEL_INTERVAL_FRAMES) {
      this.port.postMessage({
        type: 'level',
        rms: Math.sqrt(this.levelSum / this.levelCount),
        peak: this.levelPeak,
      });
      this.levelSum = 0;
      this.levelCount = 0;
      this.levelPeak = 0;
    }
    return true;
  }
}

registerProcessor('pcm-processor', PcmProcessor);
