import { afterEach, expect, it, vi } from "vitest";
import { playGreeting } from "../src/web/avatar/greeting";

function preview() {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("fetch", async () => new Response(new Uint8Array(8)));
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  const player = {
    ...node(),
    start: vi.fn(),
    stop: vi.fn(),
    onended: null as (() => void) | null,
  };
  const volume = {
    ...node(),
    gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
  };
  const context = {
    sampleRate: 48000,
    currentTime: 10,
    outputLatency: 0.06,
    state: "running",
    createAnalyser: node,
    createGain: () => volume,
    createBufferSource: () => player,
    resume: async () => {},
    close: vi.fn(async () => {}),
    decodeAudioData: async () => ({ duration: 2 }),
  };
  vi.stubGlobal(
    "AudioContext",
    class {
      constructor() {
        return context;
      }
    },
  );
  const ended = vi.fn();
  return { sound: playGreeting("zh", ended), ended, player, volume, context };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("fades a manual stop to silence before releasing the audio graph", async () => {
  const { sound, player, volume, context, ended } = preview();
  await vi.waitFor(() => expect(player.start).toHaveBeenCalledOnce());
  context.currentTime = 10.5;
  sound.stop();
  sound.stop();
  const [[when]] = player.stop.mock.calls;
  expect(when).toBeGreaterThan(context.currentTime);
  expect(when).toBeLessThan(context.currentTime + 0.03);
  expect(player.connect).toHaveBeenCalledWith(volume);
  expect(volume.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, when);
  await vi.advanceTimersByTimeAsync(60);
  expect(context.close).not.toHaveBeenCalled();
  await vi.runAllTimersAsync();
  expect(context.close).toHaveBeenCalledOnce();
  expect(ended).not.toHaveBeenCalled();
});

it("keeps the final samples of a completed greeting and reports the end once", async () => {
  const { sound, player, volume, context, ended } = preview();
  await vi.waitFor(() => expect(player.start).toHaveBeenCalledOnce());
  context.currentTime += 2;
  player.onended!();
  expect(context.close).not.toHaveBeenCalled();
  await vi.runAllTimersAsync();
  sound.stop();
  expect(ended).toHaveBeenCalledExactlyOnceWith(false);
  expect(context.close).toHaveBeenCalledOnce();
  expect(volume.gain.linearRampToValueAtTime).not.toHaveBeenCalled();
});

it("can cancel a pending greeting before the source starts", async () => {
  const { sound, player, context, ended } = preview();
  sound.stop();
  await vi.runAllTimersAsync();
  expect(context.close).toHaveBeenCalledOnce();
  expect(player.start).not.toHaveBeenCalled();
  expect(ended).not.toHaveBeenCalled();
});
