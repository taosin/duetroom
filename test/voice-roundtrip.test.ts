import { afterEach, expect, it, vi } from "vitest";
import { TurnEnd, splitSpeech } from "../src/server/call/turn-end";
import { frame, unpack } from "../src/web/call/protocol";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

afterEach(() => vi.useRealTimers());
it("joins final fragments and anchors silence to the last voice, including late recognition", () => {
  vi.useFakeTimers();
  const submit = vi.fn();
  const turn = new TurnEnd(submit, "en-US");
  turn.voice();
  turn.final("I feel");
  vi.advanceTimersByTime(500);
  turn.voice();
  vi.advanceTimersByTime(300);
  turn.final("a little nervous.");
  vi.advanceTimersByTime(349);
  expect(submit).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(submit).toHaveBeenCalledWith("I feel a little nervous.");
  turn.voice();
  vi.advanceTimersByTime(1800);
  turn.final("Tomorrow.");
  vi.advanceTimersByTime(1);
  expect(submit).toHaveBeenLastCalledWith("Tomorrow.");
});
it("preserves exact model offsets across punctuation, whitespace and Unicode", () => {
  const input = "  明天演示。  We can practice now! Sure";
  const { complete, tail } = splitSpeech(input);
  expect(complete.join("") + tail).toBe(input);
  expect(complete).toHaveLength(2);
  expect(tail.trim()).toBe("Sure");
});
it("uses bounded PCM packets with generation, segment and sequence", () => {
  const pcm = new Uint8Array([0, 1, 254, 255]);
  const bytes = frame(2, 4, 3, 99, pcm);
  expect(unpack(bytes)).toEqual({
    kind: 2,
    generation: 4,
    segment: 3,
    sequence: 99,
    pcm,
  });
  expect(() => unpack(new Uint8Array(7))).toThrow();
});
it("acknowledges a segment only when its final samples have reached the playback clock", () => {
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
  post({
    type: "pcm",
    generation: 1,
    segment: 1,
    samples: new Int16Array(100).fill(32767),
  });
  post({ type: "end", generation: 1, segment: 1 });
  const output = new Float32Array(128);
  p.process([], [[output]]);
  expect(
    p.port.postMessage.mock.calls.flat().some((v: any) => v.type === "played"),
  ).toBe(false);
  expect(output[0]).toBeGreaterThan(0.9);
  p.process([], [[output]]);
  expect(p.port.postMessage.mock.calls.flat()).toContainEqual(
    expect.objectContaining({ type: "played", generation: 1, segment: 1 }),
  );
});

it.each([8000, 16000, 44100, 48000, 96000])(
  "captures 50 exact 20ms frames per second at a device rate of %d",
  (sampleRate) => {
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
    const raw = new Float32Array(sampleRate).fill(0.25);
    for (let offset = 0; offset < sampleRate; offset += 128) {
      const block = raw.subarray(offset, offset + 128);
      p.process([[block]], [[new Float32Array(block.length)]]);
    }
    const input = p.port.postMessage.mock.calls
      .flat()
      .filter((v: any) => v.type === "input");
    expect(input).toHaveLength(50);
    expect(
      input.every(
        (v: any) =>
          v.samples.length === 320 &&
          v.samples.every((n: number) => n === 8192),
      ),
    ).toBe(true);
  },
);
