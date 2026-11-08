import { createMouthAnalyser, mouthAtRest, speakerTime } from "../audio/mouth";
import type { Lang } from "../ui";
import english from "./hello-en.wav?url";
import chinese from "./hello-zh.wav?url";

export const greetingText = {
  zh: "你好，今天过得怎么样？我在听。",
  en: "Hi. How was your day? I’m listening.",
};

// The sound and the lip samples share a clock; downloading or decoding a line
// never starts mouth movement. Create/resume audio inside the initiating tap.
export function playGreeting(lang: Lang, ended: (failed: boolean) => void) {
  const audio = new AudioContext();
  const analyser = createMouthAnalyser(audio);
  const player = audio.createBufferSource();
  const volume = audio.createGain();
  const abort = new AbortController();
  let stopped = false;
  let finishTimer: number | undefined;
  let start = Infinity;
  let end = -Infinity;

  function release() {
    window.clearTimeout(finishTimer);
    player.onended = null;
    player.disconnect();
    volume.disconnect();
    analyser.node.disconnect();
    void audio.close().catch(() => {});
  }

  function finishAfterPlayback() {
    window.clearTimeout(finishTimer);
    // Let both the render thread and the speaker drain the last samples.
    const played = Math.min(audio.currentTime, speakerTime(audio));
    finishTimer = window.setTimeout(
      () => {
        release();
        if (!stopped) {
          stopped = true;
          ended(false);
        }
      },
      Math.max(0, end - played) * 1000,
    );
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    abort.abort();
    if (!Number.isFinite(start) || audio.state !== "running") {
      release();
      return;
    }
    const now = audio.currentTime;
    if (now < end) {
      // A hard cut at a voiced sample creates a click.
      end = Math.min(end, now + 0.012);
      volume.gain.setValueAtTime(1, now);
      volume.gain.linearRampToValueAtTime(0, end);
      player.stop(end);
    }
    player.onended = null;
    finishAfterPlayback();
  }

  async function load() {
    const [, response] = await Promise.all([
      audio.resume(),
      fetch(lang === "zh" ? chinese : english, { signal: abort.signal }),
    ]);
    if (!response.ok) throw new Error("Greeting audio unavailable");
    const buffer = await audio.decodeAudioData(await response.arrayBuffer());
    if (stopped) return;
    player.buffer = buffer;
    player.connect(volume);
    volume.connect(analyser.node);
    analyser.node.connect(audio.destination);
    player.onended = finishAfterPlayback;
    start = audio.currentTime;
    end = start + buffer.duration;
    player.start(start);
  }

  void load().catch(() => {
    if (!stopped) {
      stopped = true;
      abort.abort();
      release();
      ended(true);
    }
  });
  return {
    read: () => (stopped ? mouthAtRest : analyser.read(start, end)),
    stop,
  };
}
