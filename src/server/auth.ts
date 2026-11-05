import {
  createHash,
  randomBytes,
  scrypt,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyRequest } from "fastify";

const derive = promisify(scrypt);
const cookie = "duet_session";
const lifetime = 7 * 24 * 60 * 60;
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export function bootstrap(db: Database.Database, password?: string) {
  if (db.prepare("SELECT id FROM owner WHERE id = 1").get()) return;
  if (!password || password.length < 12 || password.length > 512)
    throw new Error(
      "Set DUET_OWNER_PASSWORD_FILE to a file containing a password of 12–512 characters.",
    );
  const salt = randomBytes(16).toString("hex");
  db.prepare("INSERT INTO owner VALUES (1, ?, ?)").run(
    scryptSync(password, salt, 64).toString("hex"),
    salt,
  );
}

export function isSessionValid(db: Database.Database, req: FastifyRequest) {
  const token = req.cookies[cookie];
  return Boolean(
    token &&
    db
      .prepare("SELECT 1 FROM sessions WHERE digest = ? AND expires_at > ?")
      .get(digest(token), Date.now()),
  );
}

export function registerAuth(
  app: FastifyInstance,
  db: Database.Database,
  origin: string,
) {
  const secure = new URL(origin).protocol === "https:";
  const options = {
    path: "/",
    httpOnly: true,
    sameSite: "strict" as const,
    secure,
  };
  let attempts = 0;
  let windowEnds = 0;
  app.addHook("onRequest", async (req, reply) => {
    const path = req.routeOptions.url || "";
    if (!path.startsWith("/api/")) return;
    const mutation =
      !["GET", "HEAD", "OPTIONS"].includes(req.method) || !!req.headers.upgrade;
    if ((mutation || req.headers.origin) && req.headers.origin !== origin)
      return reply.code(403).send({ error: "origin_rejected" });
    reply.header("cache-control", "no-store");
    if (req.method === "POST" && path === "/api/session") return;
    if (!isSessionValid(db, req))
      return reply.code(401).send({ error: "login_required" });
  });
  app.post<{ Body: { password?: unknown } }>(
    "/api/session",
    async (req, reply) => {
      const now = Date.now();
      if (now >= windowEnds) {
        attempts = 0;
        windowEnds = now + 60_000;
      }
      if (attempts >= 10)
        return reply
          .header("retry-after", "60")
          .code(429)
          .send({ error: "try_later" });
      attempts++;
      const password = req.body?.password;
      if (typeof password !== "string" || !password || password.length > 512)
        return reply.code(401).send({ error: "invalid_password" });
      const owner = db
        .prepare("SELECT password_hash, salt FROM owner WHERE id=1")
        .get() as { password_hash: string; salt: string };
      const hash = (await derive(password, owner.salt, 64)) as Buffer;
      if (!timingSafeEqual(hash, Buffer.from(owner.password_hash, "hex")))
        return reply.code(401).send({ error: "invalid_password" });
      const token = randomBytes(32).toString("base64url");
      db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
      db.prepare("INSERT INTO sessions VALUES (?, ?)").run(
        digest(token),
        now + lifetime * 1000,
      );
      attempts = 0;
      return reply
        .setCookie(cookie, token, { ...options, maxAge: lifetime })
        .send({ authenticated: true });
    },
  );
  app.get("/api/session", async () => ({ authenticated: true }));
  app.delete("/api/session", async (req, reply) => {
    db.prepare("DELETE FROM sessions WHERE digest = ?").run(
      digest(req.cookies[cookie]!),
    );
    return reply.clearCookie(cookie, options).code(204).send();
  });
}
