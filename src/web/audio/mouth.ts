export type MouthShape = { open: number; round: number };

export const mouthAtRest: MouthShape = { open: 0, round: 0 };
// The render thread runs ahead of the speaker, particularly on Bluetooth.
export function speakerTime(audio: AudioContext) {
  const clock = audio.getOutputTimestamp?.();
  if (clock?.contextTime && clock.performanceTime)
    return (
      clock.contextTime + (performance.now() - clock.performanceTime) / 1000
    );
  return audio.currentTime - (audio.outputLatency || audio.baseLatency || 0.08);
}

export function createMouthAnalyser(audio: AudioContext) {
  const node = audio.createAnalyser();
  const rate = audio.sampleRate;
  const latency = Math.max(0.12, audio.outputLatency || audio.baseLatency || 0);
  node.fftSize = Math.min(
    32768,
    2 ** Math.ceil(Math.log2(rate * (latency + 0.03))),
  );
  const samples = new Float32Array(node.fftSize);
  const windowSize = Math.round(rate * 0.024);
  const lowPass = 1 - Math.exp((-2 * Math.PI * 850) / rate);

  function read(start = -Infinity, end = Infinity): MouthShape {
    if (audio.state !== "running" || start >= end) return mouthAtRest;
    const now = speakerTime(audio);
    if (now <= start || now >= end) return mouthAtRest;
    // Read the 24 ms of output ending at the estimated speaker position.
    const lag = Math.round(Math.max(0, audio.currentTime - now) * rate);
    const until = Math.max(windowSize, samples.length - lag);
    const count = Math.min(windowSize, Math.floor((now - start) * rate));
    if (count < 1) return mouthAtRest;
    node.getFloatTimeDomainData(samples);
    let energy = 0;
    let lowEnergy = 0;
    let low = 0;
    for (let i = until - count; i < until; i++) {
      const value = samples[i];
      energy += value * value;
      low += lowPass * (value - low);
      lowEnergy += low * low;
    }
    const rms = Math.sqrt(energy / count);
    if (rms <= 0.006) return mouthAtRest;
    const amount = Math.min(1, ((rms - 0.006) * 4.8) ** 0.7);
    // Darker, voiced sounds favor rounded lips. This is an acoustic estimate.
    const roundFraction = Math.max(
      0,
      Math.min(0.85, (lowEnergy / energy - 0.35) * 1.4),
    );
    const round = amount * roundFraction;
    return { open: amount - round, round };
  }
  return { node, read };
}
