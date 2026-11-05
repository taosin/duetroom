import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./app";

const port = Number(process.env.PORT || 3647);
const origin = process.env.DUET_PUBLIC_ORIGIN || "http://localhost:" + port;
const file = process.env.DUET_OWNER_PASSWORD_FILE;
const app = buildApp({
  origin,
  dataDir:
    process.env.DUET_DATA_DIR || join(homedir(), ".local", "share", "duetroom"),
  password:
    file && existsSync(file)
      ? readFileSync(file, "utf8").replace(/[\r\n]+$/, "")
      : undefined,
});
await app.listen({ host: process.env.DUET_HOST || "127.0.0.1", port });
console.log("DuetRoom: " + origin);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void app.close();
  });
