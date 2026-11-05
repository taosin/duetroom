import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { openCall } from "../src/web/call/device";
import { CallProblem } from "../src/web/call/CallPanel";

class Mic extends EventTarget {
  stop = vi.fn();
  getSettings() {
    return { deviceId: "mic" };
  }
}
class Context extends EventTarget {
  state = "running";
  audioWorklet = { addModule: async () => {} };
  resume = async () => {};
  close = vi.fn(async () => {
    this.state = "closed";
  });
  createMediaStreamSource() {
    return { connect: () => {} };
  }
}
class Socket {
  static OPEN = 1;
  readyState = 1;
  close = vi.fn();
  send = vi.fn();
}
class Worklet {
  port = { onmessage: undefined, close: vi.fn() };
  disconnect = vi.fn();
  connect = vi.fn();
  addEventListener = vi.fn();
}
let win: EventTarget & { isSecureContext: boolean };
let doc: EventTarget & { visibilityState: string };
let media: EventTarget & {
  getUserMedia: ReturnType<typeof vi.fn>;
  enumerateDevices: ReturnType<typeof vi.fn>;
};
let mic: Mic;
let ctx: Context;
let socket: Socket;
let call: ReturnType<typeof openCall>;
const ended = vi.fn();
beforeEach(() => {
  ended.mockClear();
  win = Object.assign(new EventTarget(), { isSecureContext: true });
  doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  mic = new Mic();
  ctx = new Context();
  socket = new Socket();
  media = Object.assign(new EventTarget(), {
    getUserMedia: vi.fn(async () => ({
      getTracks: () => [mic],
      getAudioTracks: () => [mic],
    })),
    enumerateDevices: vi.fn(async () => [
      { deviceId: "mic", kind: "audioinput" },
    ]),
  });
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("navigator", { mediaDevices: media });
  vi.stubGlobal("location", new URL("https://duet.test"));
  vi.stubGlobal(
    "AudioContext",
    class {
      constructor() {
        return ctx;
      }
    },
  );
  vi.stubGlobal("AudioWorkletNode", Worklet);
  vi.stubGlobal(
    "WebSocket",
    class extends Socket {
      constructor() {
        super();
        return socket;
      }
    },
  );
});
afterEach(() => {
  call?.close();
  vi.unstubAllGlobals();
});
it.each([
  "hidden",
  "pagehide",
  "devicechange",
  "ended",
  "suspended",
  "interrupted",
  "offline",
])("closes captures and never auto-redials after %s", async (kind) => {
  call = openCall("c", { event: () => {}, ended });
  await vi.waitFor(() => expect(media.getUserMedia).toHaveBeenCalledOnce());
  await new Promise((resolve) => setTimeout(resolve, 10));
  if (kind === "hidden") {
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
  } else if (kind === "pagehide" || kind === "offline")
    win.dispatchEvent(new Event(kind));
  else if (kind === "ended") mic.dispatchEvent(new Event(kind));
  else if (kind === "devicechange") {
    media.enumerateDevices.mockResolvedValue([]);
    media.dispatchEvent(new Event(kind));
  } else {
    ctx.state = kind;
    ctx.dispatchEvent(new Event("statechange"));
  }
  await vi.waitFor(() => expect(mic.stop).toHaveBeenCalledOnce(), {
    timeout: 250,
  });
  expect(ctx.close).toHaveBeenCalledOnce();
  expect(socket.close).toHaveBeenCalledOnce();
  expect(ended).toHaveBeenCalledOnce();
  doc.visibilityState = "visible";
  doc.dispatchEvent(new Event("visibilitychange"));
  expect(media.getUserMedia).toHaveBeenCalledOnce();
});
it("stops a permission grant arriving after leaving the page", async () => {
  let grant!: () => void;
  media.getUserMedia.mockImplementation(
    () =>
      new Promise((resolve) => {
        grant = () =>
          resolve({ getTracks: () => [mic], getAudioTracks: () => [mic] });
      }),
  );
  call = openCall("c", { event: () => {}, ended });
  win.dispatchEvent(new Event("pagehide"));
  grant();
  await vi.waitFor(() => expect(mic.stop).toHaveBeenCalledOnce());
  expect(ended).toHaveBeenCalledOnce();
});
it.each([
  ["en", "Microphone permission was denied.", "Back to text"],
  ["zh", "未获得麦克风权限。", "返回文字聊天"],
] as const)(
  "presents the microphone error and text fallback in %s",
  (lang, text, action) => {
    const html = renderToStaticMarkup(
      createElement(CallProblem, {
        lang,
        code: "permission",
        onBack: () => {},
      }),
    );
    expect(html).toContain(text);
    expect(html).toContain(action);
  },
);
