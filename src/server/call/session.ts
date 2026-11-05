import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import type Database from "better-sqlite3";
import type WebSocket from "ws";
import { acquireWriter, runReply, interruptTurn, ackTurn } from "../chat/turns";
import { expressionForTurn } from "../persona/mood";
import { frame, unpack } from "../../web/call/protocol";
import { recognize, synthesize, voices } from "./speech";
import { splitSpeech, TurnEnd } from "./turn-end";

type Companion = { id: string; locale: string; voice: string };
type Active = {
  generation: number;
  controller: AbortController;
  id: string;
  segment: number;
  sent: number;
  consumed: number;
  acked: number;
  endOffset: number;
  readyForAck: boolean;
  generated: string;
  delivered: number;
  fallback?: "pending" | "available" | "offered";
};
function errorCode(error: unknown) {
  const code =
    (error as { code?: string })?.code ||
    (error instanceof Error && error.message);
  return typeof code === "string" &&
    [
      "busy",
      "missing",
      "model_unconfigured",
      "model_unavailable",
      "speech_unavailable",
      "speech_unconfigured",
      "voice_unavailable",
      "recognition_failed",
      "synthesis_failed",
      "network",
    ].includes(code)
    ? code
    : "call_failed";
}

export function serveCall(
  socket: WebSocket,
  db: Database.Database,
  companion: Companion,
  authorized: () => boolean,
) {
  const writer = acquireWriter(db, companion.id);
  let closed = false;
  let started = false;
  let timeZone = "UTC";
  let generation = 0;
  let stream: ReturnType<typeof recognize> | undefined;
  let voice: Awaited<ReturnType<typeof voices>>[number];
  let active: Active | undefined;
  let sequence = 0;
  let lastPong = Date.now();
  let allowance = 1000;
  let lastInput = Date.now();
  let controls = 0;
  let controlStart = Date.now();
  const ctl = (type: string, fields: Record<string, unknown> = {}) => {
    if (!closed && socket.readyState === 1)
      socket.send(JSON.stringify({ type, ...fields }));
  };
  const stopTurn = () => {
    const a = active;
    active = undefined;
    if (!a) return;
    a.controller.abort();
    if (a.id && !writer.signal.aborted)
      interruptTurn(db, companion.id, a.id, writer);
  };
  const interrupt = () => {
    if (!active) return;
    stopTurn();
    ctl("interrupted", { generation: ++generation });
    ctl("history");
  };
  const finish = (reason?: string) => {
    if (closed) return;
    if (reason) ctl("error", { code: reason });
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(limit);
    clearTimeout(setup);
    endpoint.close();
    stopTurn();
    stream?.close();
    writer.signal.removeEventListener("abort", revoked);
    writer.release();
    socket.close(1000);
  };
  const revoked = () => finish("expired");
  const heartbeat = setInterval(() => {
    if (!authorized()) finish("expired");
    else if (Date.now() - lastPong > 16000 || socket.bufferedAmount > 50000)
      finish("network");
    else ctl("ping");
  }, 5000);
  const limit = setTimeout(() => finish("duration"), 30 * 60_000);
  const setup = setTimeout(() => finish("speech_unavailable"), 15000);
  writer.signal.addEventListener("abort", revoked, { once: true });

  async function reply(text: string) {
    if (closed || active) return;
    const a: Active = {
      generation: ++generation,
      controller: new AbortController(),
      id: "",
      segment: 0,
      sent: 0,
      consumed: 0,
      acked: 0,
      endOffset: 0,
      readyForAck: false,
      generated: "",
      delivered: 0,
    };
    active = a;
    const signal = a.controller.signal;
    let tail = "";
    ctl("reply", { generation, text });
    async function speak(sentence: string) {
      signal.throwIfAborted();
      if (!sentence.length) return;
      a.endOffset += sentence.length;
      // A whitespace-only model suffix does not constitute an audible segment.
      if (!sentence.trim()) return;
      a.segment++;
      const expression = expressionForTurn(db, a.id, voice.styles);
      const initialSequence = a.sent;
      for await (const pcm of synthesize(sentence, voice, expression, signal)) {
        const deadline = Date.now() + 8000;
        while (a.sent - a.consumed >= 6) {
          if (Date.now() > deadline) throw Error("network");
          await wait(16, undefined, { signal });
        }
        signal.throwIfAborted();
        if (closed || socket.bufferedAmount > 50000) throw Error("network");
        socket.send(frame(2, a.generation, a.segment, ++a.sent, pcm));
      }
      signal.throwIfAborted();
      if (a.sent === initialSequence) throw Error("synthesis_failed");
      a.readyForAck = true;
      ctl("segment.end", { generation: a.generation, segment: a.segment });
      const deadline = Date.now() + 15000;
      while (a.acked < a.segment) {
        if (Date.now() > deadline) throw Error("network");
        await wait(16, undefined, { signal });
      }
    }
    async function deliver(sentence: string) {
      if (a.fallback) return;
      try {
        await speak(sentence);
      } catch (error) {
        signal.throwIfAborted();
        if (errorCode(error) !== "synthesis_failed") throw error;
        a.fallback = "pending";
        a.readyForAck = false;
        ctl("synthesis.failed", { generation: a.generation });
      }
    }
    try {
      await runReply(
        db,
        companion.id,
        text,
        randomUUID(),
        signal,
        async (delta, id) => {
          a.id = id;
          a.generated += delta;
          const split = splitSpeech(tail + delta);
          tail = split.tail;
          for (const sentence of split.complete) await deliver(sentence);
        },
        {
          writer,
          mode: "voice",
          timeZone,
          onStart: (turn) => {
            a.id = turn.id;
            ctl("history");
          },
        },
      );
      await deliver(tail);
      signal.throwIfAborted();
      if (a.fallback) {
        a.fallback = "available";
        ctl("reveal.available", { generation: a.generation });
        return;
      }
      if (tail && !tail.trim() && a.acked > 0)
        ackTurn(db, companion.id, a.id, a.endOffset, writer);
      signal.throwIfAborted();
      active = undefined;
      ctl("reply.end", { generation: a.generation });
      ctl("history");
    } catch (error) {
      if (!signal.aborted && !closed) finish(errorCode(error));
    }
  }
  const endpoint = new TurnEnd((text) => {
    void reply(text);
  }, companion.locale);
  socket.once("close", () => finish());
  socket.once("error", () => finish());
  async function start(msg: Record<string, unknown>) {
    if (
      started ||
      msg.version !== 1 ||
      msg.inputRate !== 16000 ||
      msg.outputRate !== 24000
    )
      return finish("protocol");
    started = true;
    if (typeof msg.timeZone === "string" && msg.timeZone.length <= 64)
      timeZone = msg.timeZone;
    const catalog = await voices();
    if (closed) return;
    const selected = companion.voice
      ? catalog.find((v) => v.id === companion.voice)
      : catalog.find((v) => v.locale === companion.locale);
    if (!selected) return finish("voice_unavailable");
    voice = selected;
    stream = recognize(companion.locale, {
      partial: (text) => {
        if (/[^\s\p{P}]/u.test(text)) interrupt();
        endpoint.partial();
        ctl("caption", { text: text.slice(0, 4000) });
      },
      final: (text) => {
        if (/[^\s\p{P}]/u.test(text)) interrupt();
        endpoint.final(text);
        if (text) ctl("caption", { text: text.slice(0, 4000) });
      },
      failed: () => finish("recognition_failed"),
    });
    await stream.ready;
    clearTimeout(setup);
    ctl("ready", { version: 1, inputRate: 16000, outputRate: 24000 });
  }
  socket.on("message", (raw, binary) => {
    if (closed) return;
    try {
      const bytes = Array.isArray(raw)
        ? Buffer.concat(raw)
        : raw instanceof ArrayBuffer
          ? new Uint8Array(raw)
          : raw;
      if (binary) {
        const p = unpack(bytes);
        if (
          !stream ||
          p.kind !== 1 ||
          p.generation !== 0 ||
          p.segment !== 0 ||
          p.sequence !== ++sequence ||
          p.pcm.length !== 640
        )
          throw Error();
        const now = Date.now();
        allowance = Math.min(1000, allowance + now - lastInput) - 20;
        lastInput = now;
        if (allowance < 0) return finish("network");
        stream.write(p.pcm);
        return;
      }
      const now = Date.now();
      if (now - controlStart > 1000) {
        controlStart = now;
        controls = 0;
      }
      if (++controls > 100 || bytes.length > 2048) throw Error();
      const msg = JSON.parse(Buffer.from(bytes).toString("utf8"));
      if (msg.type === "call.start") {
        void start(msg).catch((e) => finish(errorCode(e)));
        return;
      }
      if (msg.type === "call.end") return finish();
      if (msg.type === "pong") {
        lastPong = Date.now();
        return;
      }
      if (msg.type === "voice") {
        endpoint.voice();
        return;
      }
      const a = active;
      if (!a || msg.generation !== a.generation) return;
      if (msg.type === "interrupt") return interrupt();
      if (msg.type === "reveal.request" && a.fallback === "available") {
        a.fallback = "offered";
        return ctl("reveal.text", {
          generation: a.generation,
          text: a.generated.slice(a.delivered),
        });
      }
      if (msg.type === "reveal.displayed" && a.fallback === "offered") {
        if (!ackTurn(db, companion.id, a.id, a.generated.length, writer))
          return finish("expired");
        active = undefined;
        ctl("reply.end", { generation: a.generation });
        return ctl("history");
      }
      if (
        msg.type === "consumed" &&
        msg.sequence === a.consumed + 1 &&
        msg.sequence <= a.sent
      )
        a.consumed++;
      if (
        msg.type === "ack" &&
        a.readyForAck &&
        msg.segment === a.acked + 1 &&
        msg.segment === a.segment &&
        a.consumed === a.sent
      ) {
        if (!ackTurn(db, companion.id, a.id, a.endOffset, writer))
          return finish("expired");
        a.readyForAck = false;
        a.acked++;
        a.delivered = a.endOffset;
        ctl("history");
      }
    } catch {
      finish("protocol");
    }
  });
}
