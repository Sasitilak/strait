/**
 * Codex CLI session emitter.
 *
 * Targets the `~/.codex/sessions/YYYY/MM/DD/rollout-<iso>-<uuid>.jsonl`
 * format observed on Codex 0.122.x.
 *
 * Resume-relevant lines (what we emit):
 *   - session_meta:  metadata header, once
 *   - turn_context:  model + cwd + sandbox/approval policies, once after meta
 *   - response_item: payload variants are the actual conversation history:
 *       { type: "message", role: "user"|"assistant", content: [{type:"input_text"|"output_text", text}] }
 *       { type: "function_call",        name, arguments: <stringified JSON>, call_id }
 *       { type: "function_call_output", call_id, output }
 *
 * We deliberately skip `event_msg` lines — they're UI replay events and the
 * Codex resume path reconstructs them from the response_items.
 *
 * Things we drop in v1 (warned at end):
 *   - thinking blocks (cannot reconstruct encrypted_content)
 *   - image blocks
 *
 * Things we approximate:
 *   - Tool name: passed through verbatim from Claude (e.g. "Bash"). Resume
 *     will display the call but won't re-execute unless that name is also
 *     a registered Codex tool. TODO: add a Claude→Codex tool name mapping.
 *   - call_id: passed through from Claude (toolu_…). Codex normally uses
 *     call_<24hex>. If resume rejects, we'll generate fresh ids and remap.
 *   - sandbox_policy/approval_policy: defaulted; user can edit if needed.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import type { Session, Message } from "../ir.js";

export interface EmitOptions {
  outputPath?: string;
  originator?: string;
  cliVersion?: string;
}

export interface EmitResult {
  outputPath: string;
  sessionId: string;
  stats: {
    messagesIn: number;
    responseItemsOut: number;
    toolCalls: number;
    toolResults: number;
    droppedThinking: number;
    droppedImages: number;
  };
}

export async function writeCodexSession(
  session: Session,
  options: EmitOptions = {},
): Promise<EmitResult> {
  const sessionId = randomUUID();
  const now = new Date();
  const outputPath = options.outputPath ?? defaultRolloutPath(now, sessionId);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const out = fs.createWriteStream(outputPath, { encoding: "utf8" });
  const write = (obj: unknown) => out.write(JSON.stringify(obj) + "\n");

  const cwd = session.workingDirectory ?? os.homedir();
  const model = session.model ?? "gpt-5.5";
  const isoNow = now.toISOString();

  // 1. session_meta
  write({
    timestamp: isoNow,
    type: "session_meta",
    payload: {
      id: sessionId,
      timestamp: isoNow,
      cwd,
      originator: options.originator ?? "strait",
      cli_version: options.cliVersion ?? "0.0.1",
      source: "strait",
      model_provider: "openai",
    },
  });

  // 2. turn_context
  write({
    timestamp: isoNow,
    type: "turn_context",
    payload: {
      turn_id: randomUUID(),
      cwd,
      current_date: isoNow.slice(0, 10),
      timezone: process.env.TZ ?? "UTC",
      approval_policy: "on-request",
      sandbox_policy: {
        type: "workspace-write",
        writable_roots: [cwd],
        network_access: false,
        exclude_tmpdir_env_var: false,
        exclude_slash_tmp: false,
      },
      model,
      personality: "friendly",
      effort: "medium",
      summary: "none",
    },
  });

  const stats = {
    messagesIn: session.messages.length,
    responseItemsOut: 0,
    toolCalls: 0,
    toolResults: 0,
    droppedThinking: 0,
    droppedImages: 0,
  };

  // 3. Walk messages, emit response_items in order.
  for (const msg of session.messages) {
    for (const block of msg.blocks) {
      const ts = msg.timestamp;
      switch (block.type) {
        case "text": {
          const role = msg.role === "assistant" ? "assistant" : "user";
          const innerType = role === "assistant" ? "output_text" : "input_text";
          write({
            timestamp: ts,
            type: "response_item",
            payload: {
              type: "message",
              role,
              content: [{ type: innerType, text: block.text }],
            },
          });
          stats.responseItemsOut++;
          break;
        }
        case "tool_call": {
          write({
            timestamp: ts,
            type: "response_item",
            payload: {
              type: "function_call",
              name: block.name,
              arguments: JSON.stringify(block.arguments ?? {}),
              call_id: block.id,
            },
          });
          stats.responseItemsOut++;
          stats.toolCalls++;
          break;
        }
        case "tool_result": {
          write({
            timestamp: ts,
            type: "response_item",
            payload: {
              type: "function_call_output",
              call_id: block.toolCallId,
              output: block.content,
            },
          });
          stats.responseItemsOut++;
          stats.toolResults++;
          break;
        }
        case "thinking":
          stats.droppedThinking++;
          break;
        case "image":
          stats.droppedImages++;
          break;
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    out.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });

  return { outputPath, sessionId, stats };
}

function defaultRolloutPath(now: Date, sessionId: string): string {
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const stamp = now.toISOString().replace(/[:.]/g, "-").replace("Z", "");
  return path.join(
    os.homedir(),
    ".codex",
    "sessions",
    yyyy,
    mm,
    dd,
    `rollout-${stamp}-${sessionId}.jsonl`,
  );
}
