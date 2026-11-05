import { EventEmitter } from "node:events";
import Database from "better-sqlite3";
import type WebSocket from "ws";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { serveCall } from "../src/server/call/session";
import {
  initChat,
  getHistory,
  clearConversation,
} from "../src/server/chat/turns";
import { registerMood } from "../src/server/persona/mood";
import { unpack } from "../src/web/call/protocol";

const external = vi.hoisted(() => ({
  hooks: undefined as
    undefined | { partial: (s: string) => void; final: (s: string) => void },
  scenario: "ok",
}));
vi.mock("../src/server/call/speech", () => ({
  voices: async () => [{ id: "test", locale: "en-US", styles: [] }],
  recognize: (_: string, hooks: NonNullable<typeof external.hooks>) => {
    external.hooks = hooks;
    return { ready: Promise.resolve(), write: () => {}, close: () => {} };
  },
  synthesize: async function* (sentence: string) {
    if (external.scenario === "fail" && sentence.includes("Second"))
      throw Error("synthesis_failed");
    yield new Uint8Array(960);
  },
}));
class Client extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  controls: Array<Record<string, any>> = [];
  packets: Array<ReturnType<typeof unpack>> = [];
  send(data: string | Uint8Array) {
    if (typeof data === "string") this.controls.push(JSON.parse(data));
    else this.packets.push(unpack(data));
  }
  command(type: string, fields: Record<string, unknown> = {}) {
    this.emit(
      "message",
      Buffer.from(JSON.stringify({ type, ...fields })),
      false,
    );
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
}
let db: Database.Database;
let client: Client;
const phrase = "First. Second.";
beforeEach(async () => {
  external.scenario = "ok";
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE companions(id TEXT PRIMARY KEY,name TEXT,persona TEXT,locale TEXT,voice TEXT); INSERT INTO companions VALUES ('c','Kai','Friendly','en-US','test')",
  );
  initChat(db);
  registerMood(db);
  client = new Client();
  vi.stubEnv("DUET_MODEL_BASE_URL", "http://local.test/v1");
  vi.stubEnv("DUET_MODEL_NAME", "test");
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        "data: " +
          JSON.stringify({ choices: [{ delta: { content: phrase } }] }) +
          "\n\ndata: [DONE]\n\n",
      ),
  );
  serveCall(
    client as unknown as WebSocket,
    db,
    { id: "c", locale: "en-US", voice: "test" },
    () => true,
  );
  client.command("call.start", {
    version: 1,
    inputRate: 16000,
    outputRate: 24000,
  });
  await vi.waitFor(() =>
    expect(client.controls.some((e) => e.type === "ready")).toBe(true),
  );
});
afterEach(() => {
  client.close();
  db.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
async function endOf(segment: number, generation = 1) {
  await vi.waitFor(() =>
    expect(
      client.controls.some(
        (e) =>
          e.type === "segment.end" &&
          e.segment === segment &&
          e.generation === generation,
      ),
    ).toBe(true),
  );
}
function ack(segment: number, generation = 1) {
  client.command("consumed", { generation, sequence: segment });
  client.command("ack", { generation, segment });
}
it("persists only played segments in the shared chat and rejects guessed acknowledgements", async () => {
  external.hooks!.final("I am nervous.");
  await endOf(1);
  expect(client.packets[0]).toMatchObject({
    kind: 2,
    generation: 1,
    segment: 1,
  });
  client.command("ack", { generation: 1, segment: 2 });
  expect(getHistory(db, "c").turns[0].assistantText).toBe("");
  ack(1);
  await endOf(2);
  expect(getHistory(db, "c").turns[0].assistantText).toBe("First.");
  ack(2);
  await vi.waitFor(() =>
    expect(getHistory(db, "c").turns[0]).toMatchObject({
      mode: "voice",
      userText: "I am nervous.",
      assistantText: phrase,
      status: "complete",
    }),
  );
});
it("drops the connection on history deletion and ignores subsequent playback", async () => {
  external.hooks!.final("Hello.");
  await endOf(1);
  clearConversation(db, "c");
  ack(1);
  expect(client.readyState).toBe(3);
  expect(getHistory(db, "c").turns).toHaveLength(0);
});

it("cancels synthesis on an interim transcript, retains the new utterance and fences stale receipts", async () => {
  external.hooks!.final("First turn.");
  await endOf(1);
  ack(1);
  await endOf(2);
  external.hooks!.partial("Actually");
  expect(client.controls.some((e) => e.type === "interrupted")).toBe(true);
  external.hooks!.final("Actually, let me try.");
  await endOf(1, 3);
  ack(2, 1);
  const turns = getHistory(db, "c").turns;
  expect(turns.find((t) => t.userText === "First turn.")).toMatchObject({
    status: "interrupted",
    assistantText: "First.",
  });
  expect(
    turns.find((t) => t.userText === "Actually, let me try."),
  ).toMatchObject({ assistantText: "" });
});
it("offers remaining generated text after synthesis fails and delivers only on explicit display", async () => {
  external.scenario = "fail";
  external.hooks!.final("Hello.");
  await endOf(1);
  ack(1);
  await vi.waitFor(() =>
    expect(client.controls.some((e) => e.type === "reveal.available")).toBe(
      true,
    ),
  );
  expect(getHistory(db, "c").turns[0].assistantText).toBe("First.");
  client.command("reveal.displayed", { generation: 1 });
  expect(getHistory(db, "c").turns[0].assistantText).toBe("First.");
  client.command("reveal.request", { generation: 1 });
  expect(client.controls.at(-1)).toMatchObject({
    type: "reveal.text",
    text: " Second.",
  });
  client.command("reveal.displayed", { generation: 1 });
  expect(getHistory(db, "c").turns[0]).toMatchObject({
    assistantText: phrase,
    status: "complete",
  });
});

it("keeps the call open after a reply ending with a line break", async () => {
  vi.stubGlobal("fetch", async () => new Response(
    "data: " + JSON.stringify({choices:[{delta:{content:"Hello.\n"}}]}) + "\n\ndata: [DONE]\n\n"
  ));
  external.hooks!.final("One.");
  await endOf(1);
  ack(1);
  await vi.waitFor(() => expect(client.controls.some(e=>e.type === "reply.end")).toBe(true));
  external.hooks!.final("Two.");
  await endOf(1, 2);
  expect(getHistory(db,"c").turns[0]).toMatchObject({userText:"One.",status:"complete"});
});
