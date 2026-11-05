import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { Companion, CompanionInput } from "../shared/companion";

const defaults: CompanionInput = {
  name: "",
  persona: "",
  locale: "zh-CN",
  voice: "",
};
const limit = { name: 80, persona: 2000, locale: 16, voice: 160 };
function parseCompanion(
  body: unknown,
  base: CompanionInput,
): CompanionInput | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const result = { ...base };
  for (const [key, value] of Object.entries(body)) {
    if (!Object.hasOwn(defaults, key) || typeof value !== "string") return null;
    const field = key as keyof CompanionInput;
    if ([...value.trim()].length > limit[field]) return null;
    result[field] = value.trim();
  }
  return result.name && ["zh-CN", "en-US"].includes(result.locale)
    ? result
    : null;
}
export function registerCompanions(
  app: FastifyInstance,
  db: Database.Database,
  beforeDelete?: (id: string) => void,
) {
  db.exec(`CREATE TABLE IF NOT EXISTS companions (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, persona TEXT NOT NULL, locale TEXT NOT NULL, voice TEXT NOT NULL
  )`);
  const byId = db.prepare("SELECT * FROM companions WHERE id=?");
  app.get("/api/companions", async () =>
    db.prepare("SELECT * FROM companions ORDER BY rowid").all(),
  );
  app.post("/api/companions", async (req, reply) => {
    const value = parseCompanion(req.body, defaults);
    if (!value) return reply.code(400).send({ error: "invalid_companion" });
    const row = { id: randomUUID(), ...value };
    db.prepare(
      "INSERT INTO companions VALUES (@id,@name,@persona,@locale,@voice)",
    ).run(row);
    return reply.code(201).send(row);
  });
  app.patch<{ Params: { id: string } }>(
    "/api/companions/:id",
    async (req, reply) => {
      const old = byId.get(req.params.id) as Companion | undefined;
      if (!old) return reply.code(404).send({ error: "not_found" });
      const value = parseCompanion(req.body, old);
      if (!value) return reply.code(400).send({ error: "invalid_companion" });
      const row = { ...value, id: old.id };
      db.prepare(
        "UPDATE companions SET name=@name,persona=@persona,locale=@locale,voice=@voice WHERE id=@id",
      ).run(row);
      return row;
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/companions/:id",
    async (req, reply) => {
      if (!byId.get(req.params.id))
        return reply.code(404).send({ error: "not_found" });
      beforeDelete?.(req.params.id);
      db.prepare("DELETE FROM companions WHERE id=?").run(req.params.id);
      return reply.code(204).send();
    },
  );
}
