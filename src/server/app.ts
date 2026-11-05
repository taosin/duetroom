import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { serveWeb } from "./web";
import { openDatabase } from "./db/open";
import { bootstrap, registerAuth } from "./auth";

export function buildApp(config: {
  dataDir: string;
  origin: string;
  password?: string;
}) {
  const origin = new URL(config.origin).origin;
  const app = Fastify({ bodyLimit: 64 * 1024, logger: false });
  const db = openDatabase(config.dataDir);
  try {
    bootstrap(db, config.password);
  } catch (error) {
    db.close();
    throw error;
  }
  app.addHook("onClose", async () => {
    db.close();
  });
  app.register(cookie);
  registerAuth(app, db, origin);
  serveWeb(app);
  return app;
}
