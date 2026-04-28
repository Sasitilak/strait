/**
 * Claude Code session emitter.
 *
 * Writes IR back out as a `.jsonl` Claude Code can resume from. Path:
 *   ~/.claude/projects/<dashed-cwd>/<session-uuid>.jsonl
 *
 * Where <dashed-cwd> = the absolute cwd with `/` replaced by `-`,
 * prefixed with a leading `-` (matches what Claude Code writes natively).
 *
 * One IR Message → one Claude line. Each line has `type: "user" | "assistant"`,
 * a `message` object with role + content blocks, and uuid/parentUuid/timestamp
 * scaffolding so resume picks it up.
 *
 * v1 limitations:
 *   - We don't emit `attachment`, `permission-mode`, or `file-history-snapshot`
 *     metadata lines. Claude resume tolerates their absence in our testing.
 *   - We don't try to bundle adjacent assistant text + tool_use into a single
 *     message; each IR block becomes its own line. Functionally equivalent
 *     for resume.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import type { Session, ContentBlock } from "../ir.js";

export interface EmitOptions {
  outputPath?: string;
  cwd?: string;
}

export interface EmitResult {
  outputPath: string;
  sessionId: string;
  stats: {
    messagesIn: number;
    linesOut: number;
    toolCalls: number;
    toolResults: number;
    droppedThinking: number;
    droppedImages: number;
  };
}

export async function writeClaudeSession(
  session: Session,
  options: EmitOptions = {},
): Promise<EmitResult> {
  const sessionId = randomUUID();
  const cwd = options.cwd ?? session.workingDirectory ?? os.homedir();
  const outputPath = options.outputPath ?? defaultClaudePath(cwd, sessionId);
  const model = session.model ?? "claude-sonnet-4-6";

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const out = fs.createWriteStream(outputPath, { encoding: "utf8" });
  const write = (obj: unknown) => out.write(JSON.stringify(obj) + "\n");

  const stats = {
    messagesIn: session.messages.length,
    linesOut: 0,
    toolCalls: 0,
    toolResults: 0,
    droppedThinking: 0,
    droppedImages: 0,
  };

  let prevUuid: string | undefined;

  for (const msg of session.messages) {
    for (const block of msg.blocks) {
      const uuid = randomUUID();
      const ts = msg.timestamp;
      const claudeBlock = toClaudeBlock(block, stats);
      if (!claudeBlock) continue;

      const role = msg.role === "assistant" ? "assistant" : "user";
      const messagePayload =
        role === "assistant"
          ? { id: `msg_${uuid.replace(/-/g, "").slice(0, 24)}`, type: "message", role, model, content: [claudeBlock] }
          : { role, content: [claudeBlock] };

      write({
        parentUuid: prevUuid ?? null,
        isSidechain: false,
        userType: "external",
        cwd,
        sessionId,
        version: "2.1.114",
        gitBranch: "",
        type: role,
        message: messagePayload,
        uuid,
        timestamp: ts,
      });
      stats.linesOut++;
      prevUuid = uuid;
    }
  }

  await new Promise<void>((resolve, reject) => {
    out.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });

  return { outputPath, sessionId, stats };
}

function toClaudeBlock(b: ContentBlock, stats: EmitResult["stats"]): unknown | null {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text };
    case "tool_call":
      stats.toolCalls++;
      return { type: "tool_use", id: b.id, name: b.name, input: b.arguments };
    case "tool_result":
      stats.toolResults++;
      return {
        type: "tool_result",
        tool_use_id: b.toolCallId,
        content: b.content,
        ...(b.isError ? { is_error: true } : {}),
      };
    case "thinking":
      stats.droppedThinking++;
      // Claude requires a non-empty signature for thinking blocks; we can't
      // reconstruct one. Drop instead of producing an invalid block.
      return null;
    case "image":
      stats.droppedImages++;
      return null;
  }
}

function defaultClaudePath(cwd: string, sessionId: string): string {
  // Claude Code encodes the cwd by replacing both `/` AND `.` with `-`.
  // e.g. /Users/ravi.tilak/Documents/strait → -Users-ravi-tilak-Documents-strait
  const dashed = cwd.replace(/[/.]/g, "-");
  return path.join(os.homedir(), ".claude", "projects", dashed, `${sessionId}.jsonl`);
}
