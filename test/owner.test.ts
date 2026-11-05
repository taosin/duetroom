import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/server/app";
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
test("bootstrap once, persist a session across restarts, revoke it on logout", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "duetroom-test-"));
  dirs.push(dataDir);
  const origin = "http://localhost:3647";
  expect(() => buildApp({ dataDir, origin })).toThrow(/password/i);
  let app = buildApp({ dataDir, origin, password: "owner-secret-phrase" });
  const input = {
    method: "POST" as const,
    url: "/api/session",
    headers: { origin },
    payload: { password: "owner-secret-phrase" },
  };
  expect(
    (
      await app.inject({
        ...input,
        headers: { origin: "https://evil.invalid" },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (await app.inject({ ...input, payload: { password: "wrong" } })).statusCode,
  ).toBe(401);
  const login = await app.inject(input);
  expect(login.statusCode).toBe(200);
  expect(login.headers["set-cookie"]).toContain("HttpOnly");
  const cookie = String(login.headers["set-cookie"]).split(";")[0];
  await app.close();
  app = buildApp({ dataDir, origin });
  expect(
    (await app.inject({ url: "/api/session", headers: { cookie } })).statusCode,
  ).toBe(200);
  await app.inject({
    url: "/api/session",
    method: "DELETE",
    headers: { origin, cookie },
  });
  expect(
    (await app.inject({ url: "/api/session", headers: { cookie } })).statusCode,
  ).toBe(401);
  await app.close();
});
