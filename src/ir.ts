/**
 * Internal Representation (IR) for an AI agent session.
 *
 * This is the canonical format strait uses internally; parsers convert into
 * it, emitters convert out of it. Translation is `parser → IR → emitter`.
 * Adding a new runtime means writing one parser and one emitter — never
 * touching the other side's code.
 */
export interface Session {
  id: string;
  sourceRuntime: SourceRuntime;
  targetRuntime?: SourceRuntime;
  createdAt: string;
  model?: string;
  workingDirectory?: string;
  messages: Message[];
}

export type SourceRuntime = "claude" | "codex" | "opencode";
// Note: SourceRuntime already included "opencode" from day 1 — strait was
// designed to be runtime-agnostic. The OpenCode parser landed in v0.0.2.

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  timestamp: string;
  parentId?: string;
  blocks: ContentBlock[];
}

export type ContentBlock =
  | TextBlock
  | ToolCallBlock
  | ToolResultBlock
  | ThinkingBlock
  | ImageBlock;

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolCallBlock {
  type: "tool_call";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolCallId: string;
  content: string;
  isError?: boolean;
}

export interface ThinkingBlock {
  type: "thinking";
  text: string;
}

export interface ImageBlock {
  type: "image";
  mediaType: string;
  data: string;
}
