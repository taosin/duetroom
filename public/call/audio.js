// Runs on the device's audio rendering thread. Stereo is mixed by the node's
// explicit mono channel configuration before reaching this processor.
class DuetAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.generation = 0;
    this.cursor = 0;
    this.hold = 0;
    this.speaking = false;
    this.capture = new Int16Array(320);
    this.count = 0;
    this.phase = 0;
    this.sum = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === "reset") {
        this.generation = data.generation;
        this.queue = [];
        this.hold = 0;
        this.speaking = false;
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
    const width = 16000 / sampleRate;
    for (const value of input) {
      // Each source sample may cover part of a 16 kHz interval or several.
      let left = width;
      while (left > 1e-9) {
        const used = Math.min(left, 1 - this.phase);
        this.sum += value * used;
        left -= used;
        this.phase += used;
        if (this.phase < 1 - 1e-9) continue;
        this.capture[this.count++] = Math.max(
          -32768,
          Math.min(32767, Math.round(this.sum * 32768)),
        );
        this.sum = 0;
        this.phase = 0;
        if (this.count === 320) this.sendInput();
      }
    }
  }
  sendInput() {
    let energy = 0;
    for (const sample of this.capture) energy += sample * sample;
    const voiced = Math.sqrt(energy / 320) > 780;
    if (voiced && this.queue.length) this.hold = Math.ceil(0.35 * sampleRate);
    this.port.postMessage(
      {
        type: "input",
        samples: this.capture,
        voiced,
        at: currentFrame / sampleRate,
      },
      [this.capture.buffer],
    );
    this.capture = new Int16Array(320);
    this.count = 0;
  }
  setSpeaking(value, offset) {
    this.speaking = value;
    this.port.postMessage({
      type: value ? "speaking" : "listening",
      bufferedMs:
        Math.max(
          0,
          this.queue.reduce((n, chunk) => n + (chunk.samples?.length || 0), 0) -
            this.cursor,
        ) / 24,
      generation: this.generation,
      at: (currentFrame + offset) / sampleRate,
    });
  }
  process(inputs, outputs) {
    if (inputs[0]?.[0]) this.captureInput(inputs[0][0]);
    const output = outputs[0][0];
    const skip = Math.min(this.hold, output.length);
    this.hold -= skip;
    if (skip && this.speaking) this.setSpeaking(false, 0);
    for (let i = skip; i < output.length; i++) {
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
      if (!chunk) {
        if (this.speaking) this.setSpeaking(false, i);
        break;
      }
      if (!this.speaking) this.setSpeaking(true, i);
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
