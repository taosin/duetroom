import { frame, unpack } from "./protocol";
import { speakerTime } from "../audio/mouth";
import { attachCallMouth } from "./playback-mouth";

type Hooks = {
  event: (event: { type: string; text?: string; generation?: number }) => void;
  ended: (code?: string) => void;
};
export function openCall(
  companionId: string,
  hooks: Hooks,
  conversationId?: string,
) {
  let stream: MediaStream | undefined;
  let socket: WebSocket | undefined;
  let context: AudioContext | undefined;
  let worklet: AudioWorkletNode | undefined;
  let mouth: ReturnType<typeof attachCallMouth> | undefined;
  let synthesisFailed = false;
  let closed = false;
  const listeners = new AbortController();
  const watch = (
    target: EventTarget,
    type: string,
    listener: EventListener,
  ) => {
    target.addEventListener(type, listener, { signal: listeners.signal });
  };
  let ready = false;
  let generation = 0;
  let sequence = 0;
  let downSequence = 0;
  let lastVoice = 0;
  let lastPlayed = 0;
  let lastVoiceAudioTime: number | undefined;
  const publish = (
    state: string,
    audioTime = context?.currentTime,
    bufferedMs = 0,
  ) => {
    window.dispatchEvent(
      new CustomEvent("duetroom:call", {
        detail: {
          companionId,
          state,
          generation,
          audioTime,
          lastVoiceAudioTime,
          bufferedMs,
        },
      }),
    );
  };
  function resetAudio(g: number) {
    mouth?.reset();
    synthesisFailed = false;
    generation = g;
    downSequence = 0;
    lastPlayed = 0;
    worklet?.port.postMessage({ type: "reset", generation: g });
  }
  let receivedAt = Date.now();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const send = (type: string, fields: Record<string, unknown> = {}) => {
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ type, ...fields }));
  };
  const watchdog = setInterval(() => {
    if (socket && Date.now() - receivedAt > 18000) close("network");
  }, 3000);
  function close(code?: string) {
    if (closed) return;
    closed = true;
    listeners.abort();
    clearInterval(watchdog);
    for (const t of timers) clearTimeout(t);
    stream?.getTracks().forEach((t) => t.stop());
    if (worklet) {
      worklet.port.onmessage = null;
      worklet.disconnect();
      worklet.port.close();
    }
    mouth?.close();
    if (context && context.state !== "closed")
      void context.close().catch(() => {});
    send("call.end");
    socket?.close();
    publish("ended");
    hooks.ended(code);
  }
  async function audioDevices() {
    const inputIds =
      stream
        ?.getAudioTracks()
        .map((track) => track.getSettings().deviceId)
        .filter(Boolean) || [];
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      return new Set(
        list
          .filter((d) => d.kind === "audioinput" || d.kind === "audiooutput")
          .map((d) => d.deviceId)
          .filter(Boolean),
      );
    } catch {
      return new Set(inputIds);
    }
  }
  async function connect() {
    if (
      !window.isSecureContext ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof AudioWorkletNode === "undefined"
    )
      throw Error("unsupported");
    watch(window, "pagehide", () => close("background"));
    watch(document, "visibilitychange", () => {
      if (document.visibilityState === "hidden") close("background");
    });
    watch(document, "freeze", () => close("background"));
    watch(window, "offline", () => close("network"));
    if (document.visibilityState === "hidden") return close("background");
    context = new AudioContext();
    const audio = context;
    // Unlock audio during the initiating tap; Safari requires a user gesture.
    const resume = audio.resume();
    const device = navigator.mediaDevices
      .getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      })
      .then((s) => {
        if (closed) s.getTracks().forEach((t) => t.stop());
        else {
          stream = s;
          for (const track of s.getAudioTracks()) {
            watch(track, "ended", () => close("device"));
            watch(track, "mute", () => close("device"));
          }
        }
      });
    await Promise.all([
      resume,
      device,
      audio.audioWorklet.addModule("/call/audio.js"),
    ]);
    if (closed || !stream) return;
    if (audio.state !== "running") return close("audio_suspended");
    watch(audio, "statechange", () => {
      if (audio.state !== "running") close("audio_suspended");
    });
    let deviceIds = await audioDevices();
    if (closed) return;
    watch(navigator.mediaDevices, "devicechange", () => {
      void audioDevices().then((ids) => {
        if ([...deviceIds].some((id) => !ids.has(id))) close("device");
        deviceIds = ids;
      });
    });
    worklet = new AudioWorkletNode(audio, "duet-audio", {
      channelCount: 1,
      channelCountMode: "explicit",
      outputChannelCount: [1],
    });
    watch(worklet, "processorerror", () => close("device"));
    audio.createMediaStreamSource(stream).connect(worklet);
    mouth = attachCallMouth(companionId, audio);
    worklet.connect(mouth.node);
    mouth.node.connect(audio.destination);
    worklet.port.onmessage = ({ data }) => {
      if (closed || !ready || !socket || socket.readyState !== WebSocket.OPEN)
        return;
      if (data.type === "input") {
        if (socket.bufferedAmount > 32000) return close("network");
        const samples = data.samples as Int16Array;
        if (data.voiced) lastVoiceAudioTime = data.at;
        if (data.voiced && Date.now() - lastVoice >= 50) {
          lastVoice = Date.now();
          send("voice");
        }
        socket.send(frame(1, 0, 0, ++sequence, new Uint8Array(samples.buffer)));
      } else if (data.generation === generation) {
        if (data.type === "speaking" || data.type === "listening") {
          if (data.type === "speaking" && !synthesisFailed)
            mouth?.speaking(data.at);
          if (data.type === "listening") mouth?.listening(data.at);
          publish(data.type, data.at, data.bufferedMs);
        }
        if (data.type === "consumed")
          send("consumed", { generation, sequence: data.sequence });
        if (data.type === "played") {
          const g = generation;
          // Rendering runs ahead of the speaker. Wait for the hardware clock,
          // or conservative output latency when the timestamp API is absent.
          const delay = Math.max(0, (data.at - speakerTime(audio)) * 1000);
          const timer = setTimeout(() => {
            timers.delete(timer);
            if (!closed && generation === g && audio.state === "running") {
              lastPlayed = data.segment;
              send("ack", { generation: g, segment: data.segment });
            }
          }, Math.ceil(delay));
          timers.add(timer);
        }
      }
    };
    const url = new URL(
      "/api/companions/" + encodeURIComponent(companionId) + "/call",
      location.href,
    );
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    if (conversationId) url.searchParams.set("conversationId", conversationId);
    receivedAt = Date.now();
    socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    socket.onopen = () =>
      send("call.start", {
        version: 1,
        inputRate: 16000,
        outputRate: 24000,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
    socket.onmessage = ({ data }) => {
      if (closed) return;
      receivedAt = Date.now();
      try {
        if (data instanceof ArrayBuffer) {
          const p = unpack(new Uint8Array(data));
          if (p.generation !== generation) return;
          if (p.kind !== 2 || p.sequence !== ++downSequence) throw Error();
          const samples = new Int16Array(
            data,
            p.pcm.byteOffset,
            p.pcm.byteLength / 2,
          );
          worklet!.port.postMessage(
            {
              type: "pcm",
              generation,
              segment: p.segment,
              sequence: p.sequence,
              samples,
            },
            [data],
          );
          return;
        }
        const msg = JSON.parse(data);
        if (msg.type === "ping") return send("pong");
        if (msg.type === "error") return close(msg.code);
        if (msg.type === "ready") {
          ready = true;
          publish("listening");
        }
        if (msg.type === "interrupted") {
          resetAudio(msg.generation);
          publish("interrupted");
        }
        if (msg.type === "synthesis.failed" && msg.generation === generation) {
          synthesisFailed = true;
          mouth?.reset();
          worklet!.port.postMessage({ type: "reset", generation });
        }
        if (msg.type === "reply") {
          resetAudio(msg.generation);
        }
        if (msg.type === "segment.end" && msg.generation === generation)
          worklet!.port.postMessage({
            type: "end",
            generation,
            segment: msg.segment,
          });
        hooks.event(msg);
      } catch {
        close("protocol");
      }
    };
    socket.onclose = () => close("network");
    socket.onerror = () => close("network");
  }
  void connect().catch((e: Error) =>
    close(
      e.name === "NotAllowedError"
        ? "permission"
        : e.message === "unsupported"
          ? "unsupported"
          : "device",
    ),
  );
  return {
    close,
    interrupt: () => {
      if (!ready || closed || generation <= 0) return;
      send("interrupt", { generation, lastPlayed });
      resetAudio(-1);
      publish("interrupted");
    },
    reveal: () => send("reveal.request", { generation }),
    displayed: (g: number) => {
      if (g === generation) send("reveal.displayed", { generation });
    },
  };
}
