/**
 * Claude Code session parser.
 *
 * Targets the v2.x JSONL format observed at
 * `~/.claude/projects/<hashed-cwd>/<session-uuid>.jsonl`.
 *
 * Each line is one event. Shapes we handle:
 *   { type: "user",      message: { role, content: string | Block[] }, uuid, parentUuid, timestamp, cwd }
 *   { type: "assistant", message: { role, content: Block[], model },    uuid, parentUuid, timestamp, cwd }
 * Blocks: text | thinking | tool_use | tool_result | image
 *
 * Lines we skip: permission-mode, attachment, file-history-snapshot,
 * last-prompt, summary — they're sidecar metadata, not turns.
 *
 * Order is preserved as it appears in the file (the file is the canonical
 * ordering — UUIDs/parentUuids form a tree but the linear order matches a
 * valid topological walk for resume purposes).
 */
import * as fs from "node:fs";
import * as readline from "node:readline";
import * as path from "node:path";
import type { Session, Message, ContentBlock } from "../ir.js";

const SKIP_TYPES = new Set([
  "permission-mode",
  "attachment",
  "file-history-snapshot",
  "last-prompt",
  "summary",
]);

export interface ParseResult {
  session: Session;
  warnings: string[];
}

export async function parseClaudeSession(filePath: string): Promise<ParseResult> {
  const warnings: string[] = [];
  const messages: Message[] = [];
  const unknownBlockTypes = new Set<string>();
  let model: string | undefined;
  let cwd: string | undefined;
  let sessionId: string | undefined;
  let firstTimestamp: string | undefined;

  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      warnings.push(`line ${lineNo}: invalid JSON, skipped`);
      continue;
    }

    if (!sessionId && typeof obj.sessionId === "string") sessionId = obj.sessionId;
    if (!cwd && typeof obj.cwd === "string") cwd = obj.cwd;
    if (!firstTimestamp && typeof obj.timestamp === "string") firstTimestamp = obj.timestamp;
    if (!model && obj.message?.model) model = obj.message.model;

    if (SKIP_TYPES.has(obj.type)) continue;
    if (obj.type !== "user" && obj.type !== "assistant") continue;

    const role = obj.message?.role === "assistant" ? "assistant" : "user";
    const blocks: ContentBlock[] = [];
    const content = obj.message?.content;

    if (typeof content === "string") {
      if (content.length > 0) blocks.push({ type: "text", text: content });
    } else if (Array.isArray(content)) {
      for (const b of content) {
        const mapped = mapBlock(b, unknownBlockTypes);
        if (mapped) blocks.push(mapped);
      }
    } else {
      warnings.push(`line ${lineNo}: message.content has unexpected shape, skipped`);
      continue;
    }

    if (blocks.length === 0) continue;

    messages.push({
      id: typeof obj.uuid === "string" ? obj.uuid : `synthetic-${lineNo}`,
      role,
      timestamp: typeof obj.timestamp === "string" ? obj.timestamp : new Date().toISOString(),
      parentId: typeof obj.parentUuid === "string" ? obj.parentUuid : undefined,
      blocks,
    });
  }

  for (const t of unknownBlockTypes) {
    warnings.push(`unknown content block type "${t}" — dropped`);
  }

  if (!sessionId) {
    sessionId = path.basename(filePath, ".jsonl");
  }

  return {
    session: {
      id: sessionId,
      sourceRuntime: "claude",
      createdAt: firstTimestamp ?? new Date().toISOString(),
      model,
      workingDirectory: cwd,
      messages,
    },
    warnings,
  };
}

function mapBlock(b: any, unknown: Set<string>): ContentBlock | null {
  if (!b || typeof b !== "object") return null;
  switch (b.type) {
    case "text":
      return { type: "text", text: typeof b.text === "string" ? b.text : "" };
    case "thinking":
      // Claude stores thinking text under `thinking`, not `text`.
      return { type: "thinking", text: typeof b.thinking === "string" ? b.thinking : "" };
    case "tool_use":
      return {
        type: "tool_call",
        id: typeof b.id === "string" ? b.id : "",
        name: typeof b.name === "string" ? b.name : "unknown",
        arguments: b.input && typeof b.input === "object" ? b.input : {},
      };
    case "tool_result": {
      let content = "";
      let isError: boolean | undefined;
      if (typeof b.content === "string") {
        content = b.content;
      } else if (Array.isArray(b.content)) {
        // Concatenate text fields. Image parts are dropped silently.
        content = b.content
          .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
          .filter(Boolean)
          .join("\n");
      }
      if (b.is_error === true) isError = true;
      return {
        type: "tool_result",
        toolCallId: typeof b.tool_use_id === "string" ? b.tool_use_id : "",
        content,
        isError,
      };
    }
    case "image":
      // v1: drop. Track once.
      unknown.add("image");
      return null;
    default:
      if (typeof b.type === "string") unknown.add(b.type);
      return null;
  }
}
