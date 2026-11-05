import { frame, unpack } from "./protocol";

type Hooks = {
  event: (event: { type: string; text?: string; generation?: number }) => void;
  ended: (code?: string) => void;
};
export function openCall(companionId: string, hooks: Hooks) {
  let stream: MediaStream | undefined;
  let socket: WebSocket | undefined;
  let context: AudioContext | undefined;
  let worklet: AudioWorkletNode | undefined;
  let closed = false;
  let ready = false;
  let generation = 0;
  let sequence = 0;
  let downSequence = 0;
  let lastVoice = 0;
  let lastPlayed = 0;
  const publish = (state: string, audioTime = context?.currentTime) => {
    window.dispatchEvent(
      new CustomEvent("duetroom:call", {
        detail: { companionId, state, generation, audioTime },
      }),
    );
  };
  function resetAudio(g: number) {
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
    clearInterval(watchdog);
    for (const t of timers) clearTimeout(t);
    stream?.getTracks().forEach((t) => t.stop());
    if (worklet) {
      worklet.port.onmessage = null;
      worklet.disconnect();
      worklet.port.close();
    }
    if (context && context.state !== "closed")
      void context.close().catch(() => {});
    send("call.end");
    socket?.close();
    publish("ended");
    hooks.ended(code);
  }
  async function connect() {
    if (
      !window.isSecureContext ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof AudioWorkletNode === "undefined"
    )
      throw Error("unsupported");
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
        else stream = s;
      });
    await Promise.all([
      resume,
      device,
      audio.audioWorklet.addModule("/call/audio.js"),
    ]);
    if (closed || !stream) return;
    worklet = new AudioWorkletNode(audio, "duet-audio", {
      channelCount: 1,
      channelCountMode: "explicit",
      outputChannelCount: [1],
    });
    audio.createMediaStreamSource(stream).connect(worklet);
    worklet.connect(audio.destination);
    worklet.port.onmessage = ({ data }) => {
      if (closed || !ready || !socket || socket.readyState !== WebSocket.OPEN)
        return;
      if (data.type === "input") {
        if (socket.bufferedAmount > 32000) return close("network");
        const samples = data.samples as Int16Array;
        if (data.voiced && Date.now() - lastVoice >= 50) {
          lastVoice = Date.now();
          send("voice");
        }
        socket.send(frame(1, 0, 0, ++sequence, new Uint8Array(samples.buffer)));
      } else if (data.generation === generation) {
        if (data.type === "speaking" || data.type === "listening")
          publish(data.type, data.at);
        if (data.type === "consumed")
          send("consumed", { generation, sequence: data.sequence });
        if (data.type === "played") {
          const g = generation;
          // Rendering runs ahead of the speaker. Wait for the hardware clock,
          // or conservative output latency when the timestamp API is absent.
          const clock = audio.getOutputTimestamp?.();
          const delay =
            clock && clock.contextTime && clock.performanceTime
              ? Math.max(
                  0,
                  clock.performanceTime +
                    (data.at - clock.contextTime) * 1000 -
                    performance.now(),
                )
              : Math.max(
                  0,
                  (data.at -
                    audio.currentTime +
                    (audio.outputLatency || audio.baseLatency || 0.08)) *
                    1000,
                );
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
        if (msg.type === "synthesis.failed")
          worklet!.port.postMessage({ type: "reset", generation });
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
