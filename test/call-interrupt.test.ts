import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

it("pauses at the local playback cursor for noise and rejects old samples after reset", () => {
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
      sampleRate: 48000,
      currentFrame: 0,
      Int16Array,
      Float32Array,
    },
  );
  const p = new Processor();
  const post = (data: any) => p.port.onmessage({ data });
  post({ type: "reset", generation: 1 });
  const samples = new Int16Array(24000).fill(15000);
  post({ type: "pcm", generation: 1, segment: 1, sequence: 1, samples });
  const block = (mic: number, n = 960) => {
    const out = new Float32Array(n);
    p.process([[new Float32Array(n).fill(mic)]], [[out]]);
    return out;
  };
  expect(block(0)[0]).toBeGreaterThan(0);
  expect(block(0.4).every((a) => a === 0)).toBe(true);
  for (let i = 0; i < 16; i++)
    expect(block(0).every((a) => a === 0)).toBe(true);
  expect(block(0, 3000).some((a) => a > 0)).toBe(true);
  post({ type: "reset", generation: 2 });
  post({ type: "pcm", generation: 1, segment: 1, sequence: 2, samples });
  expect(block(0).every((a) => a === 0)).toBe(true);
});
