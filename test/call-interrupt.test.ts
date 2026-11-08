import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

function worklet(sampleRate: number) {
  let Processor: any;
  class Base {
    port = { onmessage: undefined as any, postMessage: vi.fn() };
  }
  runInNewContext(
    readFileSync(new URL("../public/call/audio.js", import.meta.url), "utf8"),
    {
      AudioWorkletProcessor: Base,
      registerProcessor: (_: string, p: any) => {
        Processor = p;
      },
      sampleRate,
      currentFrame: 0,
      Int16Array,
      Float32Array,
    },
  );
  const p = new Processor();
  const post = (data: any) => p.port.onmessage({ data });
  const block = (mic: number, n = 960) => {
    const out = new Float32Array(n);
    p.process([[new Float32Array(n).fill(mic)]], [[out]]);
    return out;
  };
  return { post, block };
}

it("pauses at the local playback cursor for noise and rejects old samples after reset", () => {
  const { post, block } = worklet(48000);
  post({ type: "reset", generation: 1 });
  const samples = new Int16Array(24000).fill(15000);
  post({ type: "pcm", generation: 1, segment: 1, sequence: 1, samples });
  expect(block(0)[0]).toBeGreaterThan(0);
  expect(block(0.4).every((a) => a === 0)).toBe(true);
  for (let i = 0; i < 16; i++)
    expect(block(0).every((a) => a === 0)).toBe(true);
  expect(block(0, 3000).some((a) => a > 0)).toBe(true);
  post({ type: "reset", generation: 2 });
  post({ type: "pcm", generation: 1, segment: 1, sequence: 2, samples });
  expect(block(0).every((a) => a === 0)).toBe(true);
});

it.each([44100, 48000])(
  "keeps packet joins and underruns smooth at %i Hz",
  (rate) => {
    const audio = worklet(rate);
    const post = (samples: Int16Array) =>
      audio.post({ type: "pcm", generation: 0, segment: 1, samples });
    const tone = Int16Array.from({ length: 4800 }, (_, i) =>
      Math.round(14000 * Math.sin((2 * Math.PI * 353 * i) / 24000 + 1.25)),
    );
    const packet = rate / 10;
    post(tone.subarray(0, 2400));
    post(tone.subarray(2400));
    const joined = audio.block(0, 2 * packet);
    // Compare the interpolation at the seam to one uninterrupted PCM sequence.
    const cursor = ((packet - 1) * 24000) / rate;
    const fraction = cursor - Math.floor(cursor);
    const expected =
      (tone[2399] + (tone[2400] - tone[2399]) * fraction) / 32768;
    expect(joined[packet - 1]).toBeCloseTo(expected, 5);

    const gap = audio.block(0, Math.ceil(rate * 0.008));
    post(tone.subarray(0, 2400));
    const resumed = audio.block(0, Math.ceil(rate * 0.008));
    const edges = [joined[joined.length - 1], ...gap, ...resumed];
    let maxStep = 0;
    for (let i = 1; i < edges.length; i++)
      maxStep = Math.max(maxStep, Math.abs(edges[i] - edges[i - 1]));
    expect(maxStep).toBeLessThan(0.03);
    expect(gap[gap.length - 1]).toBe(0);
    expect(resumed.some((sample) => sample > 0.2)).toBe(true);
  },
);
