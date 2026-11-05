import type Database from "better-sqlite3";

type DB = Database.Database;
type MoodName = "calm" | "happy" | "concerned" | "low" | "curious";
interface Mood {
  name: MoodName;
  intensity: number;
}
interface StoredMood extends Mood {
  updatedAt: number;
}

export function registerMood(db: DB) {
  db.exec(`CREATE TABLE IF NOT EXISTS turn_expressions (
    turn_id TEXT PRIMARY KEY REFERENCES chat_turns(id) ON DELETE CASCADE,
    name TEXT NOT NULL, intensity INTEGER NOT NULL CHECK(intensity BETWEEN 0 AND 3),
    applied INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS companion_moods (
    companion_id TEXT PRIMARY KEY REFERENCES companions(id) ON DELETE CASCADE,
    source_turn TEXT NOT NULL REFERENCES chat_turns(id) ON DELETE CASCADE,
    name TEXT NOT NULL, intensity INTEGER NOT NULL CHECK(intensity BETWEEN 0 AND 3), updated_at INTEGER NOT NULL
  );`);
}

export function readMood(db: DB, companionId: string, now = Date.now()): Mood {
  const row = db
    .prepare(
      "SELECT name,intensity,updated_at AS updatedAt FROM companion_moods WHERE companion_id=?",
    )
    .get(companionId) as StoredMood | undefined;
  if (row) {
    const elapsed = Math.max(0, now - row.updatedAt);
    const intensity = row.intensity - Math.floor(elapsed / 21_600_000);
    if (intensity > 0) return { name: row.name, intensity };
  }
  return { name: "calm", intensity: 0 };
}

function onDelivered(
  db: DB,
  companionId: string,
  turnId: string,
  now = Date.now(),
) {
  db.transaction(() => {
    const proposal = db
      .prepare(
        `SELECT e.name,e.intensity FROM turn_expressions e
      JOIN chat_turns t ON t.id=e.turn_id WHERE t.companion_id=? AND t.id=? AND e.applied=0
      AND t.delivered_text<>'' AND NOT EXISTS (SELECT 1 FROM chat_turns newer
        WHERE newer.companion_id=t.companion_id AND newer.rowid>t.rowid AND newer.delivered_text<>'')`,
      )
      .get(companionId, turnId) as Mood | undefined;
    if (!proposal) return;
    const previous = readMood(db, companionId, now);
    const target = proposal.name === "calm" ? 0 : proposal.intensity;
    const intensity =
      previous.intensity + Math.sign(target - previous.intensity);
    const name =
      intensity === 0 ? "calm" : target === 0 ? previous.name : proposal.name;
    db.prepare(
      `INSERT INTO companion_moods(companion_id,source_turn,name,intensity,updated_at)
      VALUES (?,?,?,?,?) ON CONFLICT(companion_id) DO UPDATE SET source_turn=excluded.source_turn,
      name=excluded.name,intensity=excluded.intensity,updated_at=excluded.updated_at`,
    ).run(companionId, turnId, name, intensity, now);
    db.prepare("UPDATE turn_expressions SET applied=1 WHERE turn_id=?").run(
      turnId,
    );
  })();
}

// Only the initial header is a control. Ordinary bracketed prose passes through verbatim.
async function* transform(
  db: DB,
  companionId: string,
  turnId: string,
  source: AsyncIterable<string>,
) {
  const scope = "SELECT id FROM chat_turns WHERE id=? AND companion_id=?";
  // A retry of a turn with no delivered text starts with a fresh proposal.
  db.prepare(
    "DELETE FROM turn_expressions WHERE applied=0 AND turn_id IN (" +
      scope +
      ")",
  ).run(turnId, companionId);
  let stage: "header" | "separator" | "body" = "header";
  let buffer = "";
  for await (let chunk of source) {
    if (stage === "header") {
      buffer += chunk;
      const start = buffer.trimStart();
      if (!start && buffer.length > 256) {
        yield buffer;
        buffer = "";
        continue;
      }
      if ("[mood".startsWith(start.toLowerCase())) continue;
      if (!/^\[mood(?=[:\s\]=])/i.test(start)) {
        chunk = buffer;
        stage = "body";
      } else {
        const end = start.search(/[\]\n\r]/);
        if (end < 0) {
          // Keep discarding an overlong malformed header until its terminator.
          if (start.length > 96) buffer = "[mood:invalid";
          continue;
        }
        const tag = start
          .slice(0, end + 1)
          .match(/^\[mood:(calm|happy|concerned|low|curious):([0-3])\]$/);
        if (tag) {
          db.prepare(
            `INSERT OR IGNORE INTO turn_expressions(turn_id,name,intensity)
            SELECT id,?,? FROM chat_turns WHERE id=? AND companion_id=?`,
          ).run(tag[1], Number(tag[2]), turnId, companionId);
        }
        chunk = start.slice(end + 1);
        stage = "separator";
      }
      buffer = "";
    }
    if (stage === "separator") {
      chunk = chunk.trimStart();
      if (!chunk) continue;
      stage = "body";
    }
    if (chunk) yield chunk;
  }
  // EOF on an unfinished control: hide the control. Preserve ordinary prefixes such as "[".
  if (
    stage === "header" &&
    buffer &&
    !/^\[mood(?:[:\s\]=]|$)/i.test(buffer.trimStart())
  )
    yield buffer;
}

function context(db: DB, companionId: string) {
  const { name, intensity } = readMood(db, companionId);
  return `Your current mood is ${name} at intensity ${intensity}/3. It colors your own expression. Respect the owner's freedom to pause, leave or change the subject.
To suggest a mood, optionally begin your answer with one control such as [mood:curious:1]. Allowed names: calm, happy, concerned, low, curious. Intensity: 0 to 3. Follow it with your normal reply.`;
}
export const moodHooks = { context, transform, onDelivered };

const expression = {
  calm: { rate: 1, pauseMs: 110, style: "calm" },
  happy: { rate: 1.07, pauseMs: 85, style: "cheerful" },
  concerned: { rate: 0.94, pauseMs: 160, style: "empathetic" },
  low: { rate: 0.92, pauseMs: 175, style: "sad" },
  curious: { rate: 1.04, pauseMs: 95, style: "friendly" },
};

export function expressionForTurn(
  db: DB,
  turnId: string,
  supportedStyles: readonly string[] = [],
) {
  const row = db
    .prepare("SELECT name, intensity FROM turn_expressions WHERE turn_id=?")
    .get(turnId) as Mood | undefined;
  const style = expression[row && row.intensity > 0 ? row.name : "calm"];
  return {
    rate: style.rate,
    pauseMs: style.pauseMs,
    style: supportedStyles.includes(style.style) ? style.style : undefined,
  };
}
