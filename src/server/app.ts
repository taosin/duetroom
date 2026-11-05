import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { registerCall } from "./call/routes";
import { registerChat } from "./chat/routes";
import { moodHooks, registerMood } from "./persona/mood";
import { registerMemories, memoryContext } from "./persona/memories";
import { configureChat, cancelWriter } from "./chat/turns";
import cookie from "@fastify/cookie";
import { registerCompanions } from "./companions";
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
  app.register(websocket, {
    options: { maxPayload: 32_000, perMessageDeflate: false },
  });
  registerCompanions(app, db, (id) => cancelWriter(db, id));
  app.register(async (scope) => {
    registerChat(scope, db);
    registerCall(scope,db);
    registerMemories(scope, db);
    registerMood(db);
    configureChat(db, {
      ...moodHooks,
      context: (db, id, input) =>
        [moodHooks.context(db, id), memoryContext(db, id, input)]
          .filter(Boolean)
          .join("\n"),
    });
  });
  serveWeb(app);
  return app;
}
