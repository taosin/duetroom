import Fastify from "fastify";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  memoryContext,
  registerMemories,
} from "../src/server/persona/memories";

let app: ReturnType<typeof Fastify>;
let db: Database.Database;
const base = "/api/companions/a/memories";
const source = { turnId: "t1", role: "user" };
const post = (url: string, payload: object) =>
  app.inject({ method: "POST", url, payload });
beforeEach(() => {
  app = Fastify();
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE companions(id TEXT PRIMARY KEY);
    CREATE TABLE chat_turns(id TEXT PRIMARY KEY, companion_id TEXT REFERENCES companions(id) ON DELETE CASCADE,
      user_text TEXT, delivered_text TEXT, created_at INTEGER, time_zone TEXT);
    INSERT INTO companions VALUES ('a'), ('b');
    INSERT INTO chat_turns VALUES ('t1','a','明天下午演示','',1730604600000,'America/New_York'),
      ('t2','b','tomorrow morning','Delivered',1730604600000,'Asia/Shanghai');`);
  registerMemories(app, db);
});
afterEach(async () => {
  await app.close();
  db.close();
});

it("resolves relative dates from the source and allows a corrected preview to be saved", async () => {
  const preview = await post(base + "/preview", source);
  expect(preview.statusCode).toBe(200);
  expect(preview.json()).toMatchObject({
    text: "2024-11-03下午演示",
    timeZone: "America/New_York",
    createdAt: 1730604600000,
  });
  expect((await app.inject(base)).json()).toEqual([]);
  const added = await post(base, { ...source, text: "2024-11-05下午演示" });
  expect(added.statusCode).toBe(201);
  expect(memoryContext(db, "a", "演示")).toContain("2024-11-05下午演示");
  expect(
    (
      await post("/api/companions/b/memories/preview", {
        turnId: "t2",
        role: "user",
      })
    ).json().text,
  ).toBe("2024-11-04 morning");
});

it("refuses cross-companion, missing, and undelivered sources", async () => {
  for (const spec of [
    { turnId: "t2", role: "user" },
    { turnId: "absent", role: "user" },
    { ...source, role: "assistant" },
  ]) {
    expect((await post(base, { ...spec, text: "private" })).statusCode).toBe(
      404,
    );
    expect((await post(base + "/preview", spec)).statusCode).toBe(404);
  }
  expect(
    (await post(base, { ...source, role: "system", text: "private" }))
      .statusCode,
  ).toBe(400);
});

it("limits the Unicode length and number of saved facts per companion", async () => {
  expect(
    (await post(base, { ...source, text: "🍀".repeat(201) })).statusCode,
  ).toBe(400);
  for (let i = 0; i < 30; i++)
    expect(
      (await post(base, { ...source, text: "🍀".repeat(198) + i })).statusCode,
    ).toBe(201);
  expect((await post(base, { ...source, text: "extra" })).statusCode).toBe(409);
});

it("changes prompt facts immediately, scopes mutations and forgets deleted sources", async () => {
  const { id } = (await post(base, { ...source, text: "old" })).json();
  const path = base + "/" + id;
  expect(
    (
      await app.inject({
        method: "PATCH",
        url: path.replace("/a/", "/b/"),
        payload: { text: "intruder" },
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (await app.inject({ method: "DELETE", url: path.replace("/a/", "/b/") }))
      .statusCode,
  ).toBe(404);
  expect(
    (
      await app.inject({
        method: "PATCH",
        url: path,
        payload: { text: "new", pinned: true },
      })
    ).json(),
  ).toMatchObject({ text: "new", pinned: true });
  expect(memoryContext(db, "a", "")).toContain("new");
  expect(memoryContext(db, "a", "")).not.toContain("old");
  expect(memoryContext(db, "b", "")).toBe("");
  expect((await app.inject({ method: "DELETE", url: path })).statusCode).toBe(
    204,
  );
  expect(memoryContext(db, "a", "")).toBe("");
  await post(base, { ...source, text: "derived" });
  db.prepare("DELETE FROM chat_turns WHERE id = ?").run("t1");
  expect((await app.inject(base)).json()).toEqual([]);
});

it("fits whole facts, preferring relevant facts even when another was edited more recently", async () => {
  const fact = "请在演示前提醒我喝水。";
  await post(base, { ...source, text: fact });
  await post(base, { ...source, text: "偏好周末去图书馆安静读书。" });
  const full = memoryContext(db, "a", "我的演示", 300);
  const withOne = memoryContext(db, "a", "我的演示", [...full].length - 1);
  expect(withOne).toContain(fact);
  expect(withOne).not.toContain("图书馆");
  expect([...memoryContext(db, "a", "", 4)]).toHaveLength(0);
});
