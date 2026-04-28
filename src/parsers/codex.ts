/**
 * Codex CLI session parser.
 *
 * Reads a Codex rollout JSONL and produces IR. Mirror of emitters/codex.ts.
 *
 * Lines we use:
 *   session_meta  → session id, cwd, model_provider
 *   turn_context  → model, cwd (override if present)
 *   response_item / message    → text turn (input_text / output_text)
 *   response_item / function_call         → assistant tool_call
 *   response_item / function_call_output  → user tool_result
 *
 * Lines we skip (with optional warning, dedup'd):
 *   event_msg (UI replay) — never affects history
 *   response_item / reasoning (encrypted, lossy)
 *   response_item / web_search_call, custom_tool_call (out of scope v1)
 *   message role=developer (instruction scaffolding, not user content)
 */
import * as fs from "node:fs";
import * as readline from "node:readline";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { Session, Message, ContentBlock } from "../ir.js";

export interface ParseResult {
  session: Session;
  warnings: string[];
}

export async function parseCodexSession(filePath: string): Promise<ParseResult> {
  const warnings: string[] = [];
  const messages: Message[] = [];
  const skippedKinds = new Map<string, number>();
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let model: string | undefined;
  let firstTimestamp: string | undefined;

  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lineNo = 0;
  let prevId: string | undefined;
  for await (const line of rl) {
    lineNo++;
    if (!line.trim()) continue;
    let obj: any;
    try { obj = JSON.parse(line); }
    catch { warnings.push(`line ${lineNo}: invalid JSON, skipped`); continue; }

    if (!firstTimestamp && typeof obj.timestamp === "string") firstTimestamp = obj.timestamp;

    if (obj.type === "session_meta") {
      sessionId = obj.payload?.id ?? sessionId;
      cwd = obj.payload?.cwd ?? cwd;
      continue;
    }
    if (obj.type === "turn_context") {
      model = obj.payload?.model ?? model;
      cwd = obj.payload?.cwd ?? cwd;
      continue;
    }
    if (obj.type !== "response_item") {
      // event_msg etc. — skip silently
      continue;
    }

    const p = obj.payload;
    if (!p || typeof p !== "object") continue;
    const ts = typeof obj.timestamp === "string" ? obj.timestamp : new Date().toISOString();

    let role: "user" | "assistant" | undefined;
    let block: ContentBlock | undefined;

    switch (p.type) {
      case "message": {
        if (p.role === "developer") { bump(skippedKinds, "developer-message"); continue; }
        role = p.role === "assistant" ? "assistant" : "user";
        const parts: string[] = [];
        if (Array.isArray(p.content)) {
          for (const c of p.content) {
            if (c?.type === "input_text" || c?.type === "output_text") {
              if (typeof c.text === "string") parts.push(c.text);
            }
          }
        }
        const text = parts.join("\n");
        if (!text) continue;
        // Codex injects a synthetic <environment_context> user turn before
        // each real one. It's pure metadata (cwd, shell, timezone) and shows
        // up as junk in Claude. Drop it.
        if (role === "user" && isEnvironmentContextOnly(text)) {
          bump(skippedKinds, "environment_context");
          continue;
        }
        block = { type: "text", text };
        break;
      }
      case "function_call": {
        role = "assistant";
        let args: Record<string, unknown> = {};
        if (typeof p.arguments === "string") {
          try { args = JSON.parse(p.arguments) ?? {}; } catch { args = { _raw: p.arguments }; }
        } else if (p.arguments && typeof p.arguments === "object") {
          args = p.arguments;
        }
        block = {
          type: "tool_call",
          id: typeof p.call_id === "string" ? p.call_id : randomUUID(),
          name: typeof p.name === "string" ? p.name : "unknown",
          arguments: args,
        };
        break;
      }
      case "function_call_output": {
        role = "user";
        block = {
          type: "tool_result",
          toolCallId: typeof p.call_id === "string" ? p.call_id : "",
          content: typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? ""),
        };
        break;
      }
      case "reasoning":
      case "web_search_call":
      case "custom_tool_call":
      case "custom_tool_call_output":
        bump(skippedKinds, p.type);
        continue;
      default:
        bump(skippedKinds, `unknown:${p.type}`);
        continue;
    }

    if (!role || !block) continue;
    const id = randomUUID();
    messages.push({ id, role, timestamp: ts, parentId: prevId, blocks: [block] });
    prevId = id;
  }

  for (const [k, n] of skippedKinds) {
    warnings.push(`skipped ${n} ${k} ${n === 1 ? "item" : "items"}`);
  }

  if (!sessionId) sessionId = path.basename(filePath, ".jsonl");

  return {
    session: {
      id: sessionId,
      sourceRuntime: "codex",
      createdAt: firstTimestamp ?? new Date().toISOString(),
      model,
      workingDirectory: cwd,
      messages,
    },
    warnings,
  };
}

function bump(m: Map<string, number>, k: string) {
  m.set(k, (m.get(k) ?? 0) + 1);
}

function isEnvironmentContextOnly(text: string): boolean {
  const trimmed = text.trim();
  return /^<environment_context>[\s\S]*<\/environment_context>$/.test(trimmed);
}
