import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { isSessionValid } from "../auth";
import { serveCall } from "./session";
import { voices } from "./speech";

export function registerCall(app: FastifyInstance, db: Database.Database) {
  let sockets = 0;
  app.get("/api/call/voices", async () => {
    const model = process.env.DUET_MODEL_NAME || "";
    try {
      const result = await voices();
      return {
        available: result.length > 0,
        voices: result.map(({ id, name, locale }) => ({ id, name, locale })),
        model,
      };
    } catch (error) {
      return {
        available: false,
        voices: [],
        model,
        code:
          error instanceof Error && error.message === "speech_unconfigured"
            ? "speech_unconfigured"
            : "speech_unavailable",
      };
    }
  });
  app.get<{ Params: { id: string } }>(
    "/api/companions/:id/call",
    { websocket: true },
    (socket, req) => {
      const companion = db
        .prepare("SELECT id,locale,voice FROM companions WHERE id=?")
        .get(req.params.id) as
        { id: string; locale: string; voice: string } | undefined;
      try {
        if (!companion) throw Error("missing");
        if (sockets >= 3) throw Error("busy");
        serveCall(socket, db, companion, () => isSessionValid(db, req));
        sockets++;
        socket.once("close", () => {
          sockets--;
        });
      } catch (error) {
        const code =
          (error as { code?: string }).code || (error as Error).message;
        socket.send(
          JSON.stringify({
            type: "error",
            code: code === "busy" ? "busy" : "missing",
          }),
        );
        socket.close(1008);
      }
    },
  );
}
