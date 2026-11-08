import { createMouthAnalyser, speakerTime } from "../audio/mouth";
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
  const abort = new AbortController();
  let stopped = false;
  let finishTimer: number | undefined;
  let start = Infinity;
  let end = -Infinity;

  function stop() {
    if (stopped) return;
    stopped = true;
    abort.abort();
    window.clearTimeout(finishTimer);
    player.onended = null;
    if (Number.isFinite(start)) player.stop();
    player.disconnect();
    analyser.node.disconnect();
    void audio.close().catch(() => {});
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
    player.connect(analyser.node);
    analyser.node.connect(audio.destination);
    player.onended = () => {
      // Rendering finishes before the last samples reach the speakers.
      const tail = Math.max(0, end - speakerTime(audio)) * 1000;
      finishTimer = window.setTimeout(() => {
        stop();
        ended(false);
      }, tail);
    };
    start = audio.currentTime;
    end = start + buffer.duration;
    player.start(start);
  }

  void load().catch(() => {
    if (!stopped) {
      stop();
      ended(true);
    }
  });
  return { read: () => analyser.read(start, end), stop };
}
