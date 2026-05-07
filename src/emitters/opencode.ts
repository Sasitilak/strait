/**
 * OpenCode session emitter.
 *
 * Writes IR back into ~/.local/share/opencode/opencode.db. Strategy:
 *
 *   1. Refuse if any process holds opencode.db open (lsof check). OpenCode
 *      is usually running and a concurrent write would race / corrupt.
 *   2. Load the DB into memory via sql.js (read-only handle).
 *   3. INSERT one session row, one message row per IR Message, one part row
 *      per IR ContentBlock — using OpenCode's native JSON shapes.
 *   4. Export the modified DB to a buffer.
 *   5. Atomic write: temp file → fsync → rename over original.
 *
 * IR → OpenCode part-type mapping:
 *   text         → part type "text"
 *   thinking     → part type "reasoning"
 *   tool_call    → part type "tool" with state.input + status="completed"
 *                  ─ if a matching tool_result block follows, its content
 *                    becomes state.output. We collapse the call/result pair
 *                    back into a single OpenCode "tool" part.
 *   tool_result  → folded into the preceding tool_call's part (no own row)
 *   image        → dropped (deferred)
 */
import * as fs from "node:fs";
import { execSync, execFileSync } from "node:child_process";
import type { Session, ContentBlock } from "../ir.js";
import { OPENCODE_DB } from "../parsers/opencode.js";
import { openDatabase } from "../sqlite.js";

export interface EmitOptions {
  outputPath?: string;
  /** Skip the lsof safety check (caller has confirmed OpenCode is closed). */
  force?: boolean;
}

export interface EmitResult {
  outputPath: string;
  sessionId: string;
  stats: {
    messagesIn: number;
    messageRows: number;
    partRows: number;
    toolCalls: number;
    toolResultsFolded: number;
    droppedImages: number;
  };
}

export async function writeOpencodeSession(
  session: Session,
  options: EmitOptions = {},
): Promise<EmitResult> {
  const dbPath = options.outputPath ?? OPENCODE_DB;

  if (!fs.existsSync(dbPath)) {
    throw new Error(
      `OpenCode database not found at ${dbPath}. Open OpenCode at least once before importing.`,
    );
  }

  if (!options.force && isDatabaseInUse(dbPath)) {
    throw new Error(
      `OpenCode appears to be running (database is open by another process). Quit OpenCode and try again, or pass --force.`,
    );
  }

  // Pre-write: fold any pending WAL pages back into the main file. sql.js
  // reads only the main DB and would otherwise discard uncommitted-to-main
  // pages, silently losing recent OpenCode writes AND producing a result
  // that's inconsistent with the leftover sidecar files.
  checkpointWal(dbPath);

  // Load the existing DB into memory (read-only handle backed by an in-memory
  // copy — INSERTs mutate the copy; we serialize and atomic-rename back).
  const db = await openDatabase(dbPath);

  const stats: EmitResult["stats"] = {
    messagesIn: session.messages.length,
    messageRows: 0,
    partRows: 0,
    toolCalls: 0,
    toolResultsFolded: 0,
    droppedImages: 0,
  };

  try {
    const sessionId = generateId("ses");
    const now = Date.now();
    const projectId = pickProjectId(db);
    const cwd = session.workingDirectory ?? process.cwd();
    const title = pickTitle(session);
    const slug = makeSlug();

    db.run(
      `INSERT INTO session
       (id, project_id, slug, directory, title, version, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [sessionId, projectId, slug, cwd, title, "1.2.27", now, now],
    );

    let lastAssistantMsgId: string | undefined;
    let timeCursor = now;

    // Build a lookup of tool_result blocks by toolCallId so we can fold them
    // into the matching tool_call's OpenCode "tool" part.
    const resultsByCallId = new Map<string, { content: string; isError?: boolean }>();
    for (const m of session.messages) {
      for (const b of m.blocks) {
        if (b.type === "tool_result") {
          resultsByCallId.set(b.toolCallId, { content: b.content, isError: b.isError });
        }
      }
    }

    for (const msg of session.messages) {
      // Skip messages that are ONLY tool_results — those got folded above.
      if (msg.blocks.every((b) => b.type === "tool_result")) {
        stats.toolResultsFolded += msg.blocks.length;
        continue;
      }

      const messageId = generateId("msg");
      const role = msg.role === "assistant" ? "assistant" : "user";
      const messageTime = ++timeCursor;

      const messageData =
        role === "user"
          ? { role: "user", time: { created: messageTime } }
          : {
              role: "assistant",
              time: { created: messageTime, completed: messageTime + 1 },
              parentID: lastAssistantMsgId,
              modelID: session.model ?? "imported-from-strait",
              providerID: "strait",
              mode: "build",
              agent: "build",
              path: { cwd, root: "/" },
              cost: 0,
              tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              finish: "stop",
            };

      db.run(
        `INSERT INTO message (id, session_id, time_created, time_updated, data)
         VALUES (?, ?, ?, ?, ?)`,
        [messageId, sessionId, messageTime, messageTime, JSON.stringify(messageData)],
      );
      stats.messageRows++;
      if (role === "assistant") lastAssistantMsgId = messageId;

      // Emit one part row per non-tool_result block.
      for (const block of msg.blocks) {
        if (block.type === "tool_result") continue;
        const partRow = blockToPart(block, resultsByCallId, stats);
        if (!partRow) continue;
        const partId = generateId("prt");
        const partTime = ++timeCursor;
        db.run(
          `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [partId, messageId, sessionId, partTime, partTime, JSON.stringify(partRow)],
        );
        stats.partRows++;
      }
    }

    // Bump session.time_updated to whatever the last cursor reached.
    db.run(`UPDATE session SET time_updated = ? WHERE id = ?`, [timeCursor, sessionId]);

    // Export modified DB to a temp file, integrity-check it, atomic-rename
    // into place, then drop sidecar files so SQLite rebuilds them fresh.
    const exported = Buffer.from(db.export());
    const tmp = dbPath + ".strait-tmp";
    fs.writeFileSync(tmp, exported);
    const fd = fs.openSync(tmp, "r+");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }

    // Post-write verification — refuse to overwrite the live DB if our export
    // is malformed for any reason.
    if (!verifyIntegrity(tmp)) {
      try { fs.unlinkSync(tmp); } catch {}
      throw new Error(
        "Exported DB failed integrity check; original left untouched. " +
        "(This usually means sql.js produced an invalid serialization.)",
      );
    }

    fs.renameSync(tmp, dbPath);
    // Stale -wal / -shm reference page versions in the OLD main file. Leaving
    // them causes SQLite to report `database disk image is malformed` on the
    // next open. Removing them is safe — SQLite recreates them on demand.
    for (const sidecar of [dbPath + "-wal", dbPath + "-shm"]) {
      try { fs.unlinkSync(sidecar); } catch {}
    }

    return { outputPath: dbPath, sessionId, stats };
  } finally {
    db.close();
  }
}

function blockToPart(
  block: ContentBlock,
  results: Map<string, { content: string; isError?: boolean }>,
  stats: EmitResult["stats"],
): unknown | null {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text, tool: null, callID: null };
    case "thinking":
      return { type: "reasoning", text: block.text, tool: null, callID: null };
    case "tool_call": {
      stats.toolCalls++;
      const result = results.get(block.id);
      const state = result
        ? {
            status: result.isError ? "error" : "completed",
            input: block.arguments ?? {},
            ...(result.isError ? { error: result.content } : { output: result.content }),
          }
        : { status: "pending", input: block.arguments ?? {} };
      if (result) stats.toolResultsFolded++;
      return {
        type: "tool",
        callID: block.id,
        tool: block.name,
        state,
        text: "",
      };
    }
    case "image":
      stats.droppedImages++;
      return null;
    case "tool_result":
      return null; // folded
  }
}

function checkpointWal(dbPath: string): void {
  // Best-effort. If `sqlite3` isn't on PATH, or there's no WAL, skip silently.
  // We only need this when there ARE pending pages — which our 0-byte WAL
  // case usually doesn't have, but we run it unconditionally because the
  // cost is microseconds and the failure mode (silent data loss) is severe.
  if (!fs.existsSync(dbPath + "-wal")) return;
  try {
    execFileSync("sqlite3", [dbPath, "PRAGMA wal_checkpoint(TRUNCATE);"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // sqlite3 not installed or DB locked — proceed; we'll catch corruption
    // at the post-write integrity step.
  }
}

function verifyIntegrity(dbPath: string): boolean {
  try {
    // -readonly avoids creating WAL/SHM sidecars next to our tmp file that
    // would then become orphans after the atomic rename.
    const out = execFileSync("sqlite3", ["-readonly", dbPath, "PRAGMA integrity_check;"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.trim() === "ok";
  } catch {
    // No system sqlite3 available — degrade gracefully. The atomic rename
    // still happens; we just can't pre-verify. This is the same risk we had
    // before adding the check, so it's a strict improvement.
    return true;
  }
}

function isDatabaseInUse(dbPath: string): boolean {
  try {
    const out = execSync(`lsof -- ${JSON.stringify(dbPath)} 2>/dev/null`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    // First line is the lsof header; any subsequent non-empty line means a holder.
    return out.split("\n").slice(1).some((l) => l.trim().length > 0);
  } catch {
    // lsof exits non-zero when no processes hold the file — that's the safe path.
    return false;
  }
}

function pickProjectId(db: any): string {
  const stmt = db.prepare("SELECT id FROM project WHERE id = 'global' LIMIT 1");
  try {
    if (stmt.step()) return "global";
  } finally { stmt.free(); }
  // Fallback to any project row.
  const any = db.prepare("SELECT id FROM project LIMIT 1");
  try {
    if (any.step()) return (any.getAsObject() as any).id;
  } finally { any.free(); }
  // No project at all — create a global one.
  const now = Date.now();
  db.run(
    `INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?)`,
    ["global", "/", now, now, "[]"],
  );
  return "global";
}

function pickTitle(session: Session): string {
  for (const m of session.messages) {
    if (m.role !== "user") continue;
    for (const b of m.blocks) {
      if (b.type === "text" && b.text.trim()) {
        return b.text.replace(/\s+/g, " ").slice(0, 60).trim();
      }
    }
  }
  return `Imported from ${session.sourceRuntime} via strait`;
}

function makeSlug(): string {
  // OpenCode's slugs look like "glowing-harbor". Pick from a small word list.
  const a = ["bright", "glowing", "calm", "swift", "quiet", "wild", "ancient", "hidden", "open", "rolling"];
  const b = ["harbor", "strait", "passage", "tide", "channel", "sound", "current", "wake", "shore", "horizon"];
  return a[Math.floor(Math.random() * a.length)] + "-" + b[Math.floor(Math.random() * b.length)];
}

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
function generateId(prefix: "ses" | "msg" | "prt"): string {
  let out = prefix + "_";
  for (let i = 0; i < 25; i++) {
    out += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  }
  return out;
}

