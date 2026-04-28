/**
 * OpenCode session parser.
 *
 * OpenCode stores everything in a single SQLite db at
 *   ~/.local/share/opencode/opencode.db
 *
 * Three relevant tables:
 *   session(id, directory, title, time_created, ...)
 *   message(id, session_id, time_created, data:json)   role, parentID, modelID
 *   part(id, message_id, session_id, time_created, data:json)
 *
 * Each part has a `type`:
 *   text        → TextBlock
 *   reasoning   → ThinkingBlock
 *   tool        → split into a ToolCall (assistant) + ToolResult (user) pair
 *                 ─ one part contains both the input and the completed output
 *   patch       → drop v1 (OpenCode-specific structured diff)
 *   file        → drop v1 (image / attachment)
 *   step-start, step-finish, compaction → metadata, skip
 *
 * The "filePath" arg is a synthetic identifier of the form
 *   "opencode://<session-id>" — we don't actually point at a file.
 */
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../sqlite.js";
import type { Session, Message, ContentBlock } from "../ir.js";

export const OPENCODE_DB = path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
export const OPENCODE_PREFIX = "opencode://";

export interface ParseResult {
  session: Session;
  warnings: string[];
}

export function isOpencodeRef(ref: string): boolean {
  return ref.startsWith(OPENCODE_PREFIX);
}

/** Returns the OpenCode session id from a parser ref like "opencode://ses_…". */
export function refToSessionId(ref: string): string {
  return ref.slice(OPENCODE_PREFIX.length);
}

export function sessionIdToRef(id: string): string {
  return OPENCODE_PREFIX + id;
}

export async function parseOpencodeSession(ref: string): Promise<ParseResult> {
  const sessionId = isOpencodeRef(ref) ? refToSessionId(ref) : ref;
  const db = await openDatabase(OPENCODE_DB);
  try {
    const row = queryOne<{ id: string; directory: string; title: string; time_created: number }>(
      db,
      "SELECT id, directory, title, time_created FROM session WHERE id = $id",
      { $id: sessionId },
    );
    if (!row) throw new Error(`OpenCode session not found: ${sessionId}`);

    const messageRows = queryAll<{ id: string; time_created: number; data: string }>(
      db,
      "SELECT id, time_created, data FROM message WHERE session_id = $sid ORDER BY time_created, id",
      { $sid: sessionId },
    );

    const partsByMessage = new Map<string, { time_created: number; data: string }[]>();
    const partRows = queryAll<{ message_id: string; time_created: number; data: string }>(
      db,
      "SELECT message_id, time_created, data FROM part WHERE session_id = $sid ORDER BY message_id, time_created, id",
      { $sid: sessionId },
    );
    for (const p of partRows) {
      let arr = partsByMessage.get(p.message_id);
      if (!arr) { arr = []; partsByMessage.set(p.message_id, arr); }
      arr.push({ time_created: p.time_created, data: p.data });
    }

    const messages: Message[] = [];
    const warnings: string[] = [];
    const skipCounts = new Map<string, number>();
    let model: string | undefined;
    let prevId: string | undefined;

    for (const m of messageRows) {
      let mdata: any;
      try { mdata = JSON.parse(m.data); }
      catch { warnings.push(`message ${m.id}: invalid JSON, skipped`); continue; }
      if (!model && typeof mdata.modelID === "string") model = mdata.modelID;

      const role = mdata.role === "assistant" ? "assistant" : "user";
      const parts = partsByMessage.get(m.id) ?? [];
      // Each tool part may need to fan out into TWO IR messages (call + result).
      for (const p of parts) {
        let pdata: any;
        try { pdata = JSON.parse(p.data); }
        catch { bump(skipCounts, "invalid-part-json"); continue; }

        const ts = new Date(p.time_created).toISOString();

        switch (pdata.type) {
          case "text": {
            const text = typeof pdata.text === "string" ? pdata.text : "";
            if (!text) continue;
            const id = randomUUID();
            messages.push({
              id, role, timestamp: ts, parentId: prevId,
              blocks: [{ type: "text", text }],
            });
            prevId = id;
            break;
          }
          case "reasoning": {
            const text = typeof pdata.text === "string" ? pdata.text : "";
            if (!text) continue;
            const id = randomUUID();
            messages.push({
              id, role: "assistant", timestamp: ts, parentId: prevId,
              blocks: [{ type: "thinking", text }],
            });
            prevId = id;
            break;
          }
          case "tool": {
            const callId = typeof pdata.callID === "string" ? pdata.callID : randomUUID();
            const name = typeof pdata.tool === "string" ? pdata.tool : "unknown";
            const input = pdata.state?.input;
            const args = (input && typeof input === "object") ? input : {};

            const callMsgId = randomUUID();
            messages.push({
              id: callMsgId, role: "assistant", timestamp: ts, parentId: prevId,
              blocks: [{ type: "tool_call", id: callId, name, arguments: args }],
            });
            prevId = callMsgId;

            // Output, if the tool completed
            const status = pdata.state?.status;
            const output = pdata.state?.output;
            if (status === "completed" && (typeof output === "string" || output != null)) {
              const resMsgId = randomUUID();
              messages.push({
                id: resMsgId, role: "user", timestamp: ts, parentId: prevId,
                blocks: [{
                  type: "tool_result",
                  toolCallId: callId,
                  content: typeof output === "string" ? output : JSON.stringify(output),
                }],
              });
              prevId = resMsgId;
            } else if (status === "error") {
              const errMsgId = randomUUID();
              messages.push({
                id: errMsgId, role: "user", timestamp: ts, parentId: prevId,
                blocks: [{
                  type: "tool_result",
                  toolCallId: callId,
                  content: typeof pdata.state?.error === "string" ? pdata.state.error : "tool error",
                  isError: true,
                }],
              });
              prevId = errMsgId;
            }
            break;
          }
          case "step-start":
          case "step-finish":
          case "compaction":
            // Pure metadata — silent skip.
            break;
          case "patch":
          case "file":
            bump(skipCounts, pdata.type);
            break;
          default:
            bump(skipCounts, `unknown:${pdata.type ?? "?"}`);
        }
      }
    }

    for (const [k, n] of skipCounts) {
      warnings.push(`skipped ${n} ${k} ${n === 1 ? "part" : "parts"}`);
    }

    return {
      session: {
        id: row.id,
        sourceRuntime: "opencode",
        createdAt: new Date(row.time_created).toISOString(),
        model,
        workingDirectory: row.directory,
        messages,
      },
      warnings,
    };
  } finally {
    db.close();
  }
}

function bump(m: Map<string, number>, k: string) {
  m.set(k, (m.get(k) ?? 0) + 1);
}

// Tiny shim over sql.js so the parser code reads like better-sqlite3 did.
function queryAll<T>(db: any, sql: string, params: Record<string, unknown>): T[] {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const rows: T[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject() as T);
    return rows;
  } finally {
    stmt.free();
  }
}

function queryOne<T>(db: any, sql: string, params: Record<string, unknown>): T | undefined {
  const rows = queryAll<T>(db, sql, params);
  return rows[0];
}
