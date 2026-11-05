import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/server/app";

test("independent identities survive a restart and can be edited and deleted", async () => {
  const origin = "http://localhost:3647",
    dataDir = mkdtempSync(join(tmpdir(), "companions-test-"));
  let app = buildApp({ origin, dataDir, password: "test-only-password" });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin },
      payload: { password: "test-only-password" },
    });
    const headers = {
      origin,
      cookie: String(res.headers["set-cookie"]).split(";")[0],
    };
    const add = (locale: string) =>
      app.inject({
        method: "POST",
        url: "/api/companions",
        headers,
        payload: { name: "🌻", locale, persona: "Kind" },
      });
    const a = await add("zh-CN"),
      b = await add("en-US");
    expect(a.statusCode).toBe(201);
    expect(a.json().id).not.toBe(b.json().id);
    const url = "/api/companions/" + a.json().id;
    expect(
      (
        await app.inject({
          method: "PATCH",
          url,
          headers,
          payload: { name: " " },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url,
          headers,
          payload: { name: "知夏" },
        })
      ).json(),
    ).toMatchObject({ name: "知夏", locale: "zh-CN" });
    await app.close();
    app = buildApp({ dataDir, origin });
    expect(
      (await app.inject({ url: "/api/companions", headers }))
        .json()
        .map((x: { name: string }) => x.name),
    ).toContain("知夏");
    expect(
      (await app.inject({ method: "DELETE", url, headers })).statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ url: "/api/companions", headers })).json(),
    ).toHaveLength(1);
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
