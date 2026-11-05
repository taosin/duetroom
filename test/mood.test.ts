import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  expressionForTurn,
  moodHooks,
  readMood,
  registerMood,
} from "../src/server/persona/mood";

let db: Database.Database;
const h = 3_600_000;
const write = (id: string) =>
  db.prepare("UPDATE chat_turns SET delivered_text='heard' WHERE id=?").run(id);
function deliver(id: string, hour: number) {
  write(id);
  moodHooks.onDelivered(db, "a", id, hour * h);
}
const turn = async (id: string, ...parts: string[]) => {
  async function* stream() {
    yield* parts;
  }
  let text = "";
  for await (const chunk of moodHooks.transform(db, "a", id, stream()))
    text += chunk;
  return text;
};
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE companions(id TEXT PRIMARY KEY);
    CREATE TABLE chat_turns(id TEXT PRIMARY KEY, companion_id TEXT REFERENCES companions(id) ON DELETE CASCADE, delivered_text TEXT);
    INSERT INTO companions VALUES ('a'),('b');
    INSERT INTO chat_turns VALUES ('t1','a',''),('t2','a',''),('t3','a','');`);
  registerMood(db);
});
afterEach(() => db.close());

it("streams plain text and strips only an opening expression control", async () => {
  expect(await turn("t1", "  [mo", "od:concerned:", "3]\n", "说说看。")).toBe(
    "说说看。",
  );
  expect(await turn("t2", "An ", "[example]")).toBe("An [example]");
  expect(await turn("t3", "[m", "usic] Hello")).toBe("[music] Hello");
  expect(expressionForTurn(db, "t1").rate).toBeLessThan(1);
});

it("hides invalid controls while preserving the answer and using neutral speech", async () => {
  expect(await turn("t1", "[mood:invented:999]", "Hello")).toBe("Hello");
  expect(await turn("t2", "[mood:no closing bracket\n", "Still here")).toBe(
    "Still here",
  );
  expect(await turn("t3", "[mood:")).toBe("");
  expect(expressionForTurn(db, "t1").rate).toBe(1);
  deliver("t1", 0);
  expect(readMood(db, "a", 0)).toEqual({ name: "calm", intensity: 0 });
});

it("applies one level only with confirmed delivery, ignoring repeated and older callbacks", async () => {
  await turn("t1", "[mood:happy:3]1");
  await turn("t2", "[mood:curious:3]2");
  moodHooks.onDelivered(db, "a", "t1", 0);
  expect(readMood(db, "a", 0)).toEqual({ name: "calm", intensity: 0 });
  deliver("t2", 0);
  deliver("t2", 1);
  deliver("t1", 1);
  expect(readMood(db, "a", h)).toEqual({ name: "curious", intensity: 1 });
  await turn("t3", "[mood:curious:3]3");
  deliver("t3", 2);
  expect(readMood(db, "a", 8 * h - 1)).toEqual({
    name: "curious",
    intensity: 2,
  });
  expect(readMood(db, "a", 8 * h)).toEqual({ name: "curious", intensity: 1 });
  expect(readMood(db, "a", 14 * h)).toEqual({ name: "calm", intensity: 0 });
  expect(readMood(db, "b", 2 * h)).toEqual({ name: "calm", intensity: 0 });
});

it("clears the state when the source is deleted and declines late updates", async () => {
  await turn("t1", "[mood:low:2]Here.");
  deliver("t1", 0);
  expect(readMood(db, "a", 0).name).toBe("low");
  db.prepare("DELETE FROM chat_turns WHERE id='t1'").run();
  moodHooks.onDelivered(db, "a", "t1", h);
  expect(readMood(db, "a", h)).toEqual({ name: "calm", intensity: 0 });
});

it("uses only styles supported by the selected voice", async () => {
  await turn("t1", "[mood:happy:2]Hello");
  expect(expressionForTurn(db, "t1", []).style).toBeUndefined();
  expect(expressionForTurn(db, "t1", ["cheerful"]).style).toBe("cheerful");
  expect(expressionForTurn(db, "t1", ["cheerful"]).rate).toBeGreaterThan(1);
});
