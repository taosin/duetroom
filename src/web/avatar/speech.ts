import type { ModelViewerElement } from "@google/model-viewer";
import type { MouthShape } from "../audio/mouth";

// Both constant poses blend over the idle clip, which owns the eyes and breathing.
export function followSpeech(
  viewer: ModelViewerElement,
  read: () => MouthShape,
) {
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const poses = ["SpeechOpen", "SpeechRound"] as const;
  const previous = [0, 0];
  let frame = 0;
  let lastTime = 0;
  let open = 0;
  let round = 0;

  function blend(index: number, value: number) {
    const weight = Math.round(value * 128) / 128;
    if (weight === previous[index]) return;
    previous[index] = weight;
    if (weight === 0) viewer.detachAnimation(poses[index], { fade: false });
    else
      viewer.appendAnimation(poses[index], {
        weight,
        time: 0.5,
        timeScale: 0,
        fade: false,
      });
  }

  function neutral() {
    cancelAnimationFrame(frame);
    lastTime = open = round = 0;
    blend(0, 0);
    blend(1, 0);
    // Layer changes unpause the model-viewer mixer, even when a pose is removed.
    if (motion.matches) {
      viewer.pause();
      viewer.currentTime = 0;
    }
  }

  function tick(time: number) {
    const shape = read();
    const dt = lastTime ? Math.min(100, time - lastTime) : 16;
    const alpha = 1 - Math.exp(-dt / 25);
    if (shape.open === 0 && shape.round === 0) {
      open = round = 0;
    } else {
      open += (shape.open - open) * alpha;
      round += (shape.round - round) * alpha;
    }
    blend(0, open);
    blend(1, round);
    lastTime = time;
    frame = requestAnimationFrame(tick);
  }

  function update() {
    neutral();
    if (!motion.matches && !document.hidden)
      frame = requestAnimationFrame(tick);
  }

  update();
  motion.addEventListener("change", update);
  document.addEventListener("visibilitychange", update);
  return () => {
    motion.removeEventListener("change", update);
    document.removeEventListener("visibilitychange", update);
    neutral();
  };
}
