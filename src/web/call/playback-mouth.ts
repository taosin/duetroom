import {
  createMouthAnalyser,
  mouthAtRest,
  type MouthShape,
} from "../audio/mouth";

let active: { companionId: string; read: () => MouthShape } | undefined;

export function readPlaybackMouth(companionId: string): MouthShape {
  if (!active || companionId !== active.companionId) return mouthAtRest;
  return active.read();
}

export function attachCallMouth(companionId: string, audio: AudioContext) {
  const { node, read } = createMouthAnalyser(audio);
  let start = Infinity;
  let end = -Infinity;
  const source = { companionId, read: () => read(start, end) };
  active = source;
  return {
    node,
    speaking(at: number) {
      start = Math.min(start, at);
      end = Infinity;
    },
    listening(at: number) {
      end = at;
    },
    reset() {
      start = Infinity;
      end = -Infinity;
    },
    close() {
      if (active === source) active = undefined;
      node.disconnect();
    },
  };
}
