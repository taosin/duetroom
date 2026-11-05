// Runs on the device's audio rendering thread. Stereo is mixed by the node's
// explicit mono channel configuration before reaching this processor.
class DuetAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.generation = 0;
    this.cursor = 0;
    this.capture = new Int16Array(320);
    this.count = 0;
    this.phase = 0;
    this.sum = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === "reset") {
        this.generation = data.generation;
        this.queue = [];
        this.cursor = 0;
      } else if (
        data.generation === this.generation &&
        (data.type === "pcm" || data.type === "end")
      ) {
        this.queue.push(data);
      }
    };
  }
  captureInput(input) {
    for (const value of input) {
      // Integrate over the original sample interval, including fractional boundaries.
      const width = 16000 / sampleRate;
      const used = Math.min(width, 1 - this.phase);
      this.sum += value * used;
      this.phase += used;
      if (this.phase < 1 - 1e-9) continue;
      this.capture[this.count++] = Math.max(
        -32768,
        Math.min(32767, Math.round(this.sum * 32768)),
      );
      this.phase = width - used;
      this.sum = value * this.phase;
      if (this.count === 320) {
        this.port.postMessage({ type: "input", samples: this.capture }, [
          this.capture.buffer,
        ]);
        this.capture = new Int16Array(320);
        this.count = 0;
      }
    }
  }
  process(inputs, outputs) {
    if (inputs[0]?.[0]) this.captureInput(inputs[0][0]);
    const output = outputs[0][0];
    for (let i = 0; i < output.length; i++) {
      while (this.queue.length && this.queue[0].type === "end") {
        const marker = this.queue.shift();
        this.port.postMessage({
          type: "played",
          generation: this.generation,
          segment: marker.segment,
          at: (currentFrame + i) / sampleRate,
        });
      }
      const chunk = this.queue[0];
      if (!chunk) break;
      const index = Math.floor(this.cursor);
      const fraction = this.cursor - index;
      const a = chunk.samples[index];
      const b = chunk.samples[Math.min(index + 1, chunk.samples.length - 1)];
      output[i] = (a + (b - a) * fraction) / 32768;
      this.cursor += 24000 / sampleRate;
      if (this.cursor >= chunk.samples.length) {
        this.cursor -= chunk.samples.length;
        this.queue.shift();
        this.port.postMessage({
          type: "consumed",
          generation: this.generation,
          sequence: chunk.sequence,
        });
      }
    }
    return true;
  }
}
registerProcessor("duet-audio", DuetAudio);
