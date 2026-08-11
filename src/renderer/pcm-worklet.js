// Runs on the audio thread. Converts the mixed mono float stream to 16-bit PCM
// and ships it to the main thread in ~256 ms batches, while continuously
// reporting a level so the app can notice a meeting starting.

const BATCH_SAMPLES = 4096; // at 16 kHz => 256 ms
const LEVEL_INTERVAL_SAMPLES = 1600; // ~100 ms

class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.batch = new Int16Array(BATCH_SAMPLES);
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
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;

    for (let i = 0; i < ch.length; i++) {
      const s = ch[i];
      const a = s < 0 ? -s : s;
      this.levelSum += s * s;
      if (a > this.levelPeak) this.levelPeak = a;
      this.levelCount++;

      if (this.recording) {
        // Clamp before scaling so loud passages saturate instead of wrapping.
        const clamped = s > 1 ? 1 : s < -1 ? -1 : s;
        this.batch[this.batchLen++] = Math.round(clamped * 32767);
        if (this.batchLen === BATCH_SAMPLES) this.flush();
      }
    }

    if (this.levelCount >= LEVEL_INTERVAL_SAMPLES) {
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
