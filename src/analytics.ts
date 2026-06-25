/**
 * Metadata snapshot — the data contract between the strait CLI and the future
 * analytics web platform.
 *
 * PRIVACY BY CONSTRUCTION: every field below is a name, a count, a date, or a
 * hash. No type here can hold message text, code, file paths, or tool argument
 * values. `JSON.stringify(snapshot)` is the exact wire format `strait push`
 * uploads — there is no separate serializer, so the type *is* the privacy
 * guarantee. Bump SNAPSHOT_SCHEMA_VERSION on any breaking field change so the
 * server can discriminate.
 */
import type { SourceRuntime, TokenUsage } from "./ir.js";

export const SNAPSHOT_SCHEMA_VERSION = 1 as const;

export type Runtime = SourceRuntime;

/** name -> count. The sole aggregation primitive. */
export type CountMap = Record<string, number>;

export interface ActivityDay {
  date: string; // "YYYY-MM-DD" (UTC)
  sessions: number;
  messages: number;
  toolCalls: number;
  tokens: number; // total tokens attributed to sessions created this day
}

export interface RuntimeBreakdown {
  runtime: Runtime;
  sessions: number;
  messages: number;
  toolCalls: number;
  tokens: TokenUsage;
}

/**
 * Activity histograms by local time of the machine that generated the snapshot.
 * Counts are messages. `byWeekday[0]` is Sunday; `byHour` is 0–23 local hour.
 */
export interface TimePatterns {
  byWeekday: number[]; // length 7, 0=Sunday
  byHour: number[]; // length 24
}

export interface SnapshotTotals {
  sessions: number;
  messages: number;
  toolCalls: number;
  distinctTools: number;
  distinctMcpServers: number;
  distinctSkills: number;
  firstActivity: string | null; // earliest day "YYYY-MM-DD"
  lastActivity: string | null;
}

export interface MetadataSnapshot {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  generatedAt: string; // ISO 8601
  generatedBy: string; // `strait-cli@<version>`
  toolCounts: CountMap; // every tool name, including raw `mcp__*` names
  mcpServerCounts: CountMap; // server parsed from `mcp__<server>__<tool>`
  /**
   * Installed Claude Code skills (value 1 = present). NOTE: per-skill *usage*
   * counts would require reading tool argument values, which is deliberately
   * out of bounds for privacy, so M1 reports the installed inventory only. The
   * raw `Skill` tool count still appears in `toolCounts`. Clean extension point.
   */
  skillUsage: CountMap;
  modelCounts: CountMap; // model string -> session count
  tokenTotals: TokenUsage; // summed across all sessions
  runtimeBreakdown: RuntimeBreakdown[];
  activity: ActivityDay[]; // ascending by date
  timePatterns: TimePatterns; // message histograms by local weekday / hour
  totals: SnapshotTotals;
  projectCount: number; // distinct hashed cwd basenames — never the paths
}

/** Fresh (non-cached) tokens — the meaningful "work done" figure. */
export function freshTokens(u: TokenUsage): number {
  return u.input + u.output;
}

/**
 * Returns the MCP server name from a Claude tool name, or null if not an MCP
 * tool. Claude names MCP tools `mcp__<server>__<tool>`; the server/tool boundary
 * is the FIRST `__` after the prefix (server names may contain single `_`, e.g.
 * `mcp__claude_ai_Gmail__send` → `claude_ai_Gmail`). Splitting on the first `__`
 * also keeps tool names that themselves contain `__` attributed to the right server.
 */
export function mcpServerOf(toolName: string): string | null {
  if (!toolName.startsWith("mcp__")) return null;
  const rest = toolName.slice(5);
  const sep = rest.indexOf("__");
  if (sep <= 0) return null;
  return rest.slice(0, sep);
}

export function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
}

export function addUsage(into: TokenUsage, from: TokenUsage): void {
  into.input += from.input;
  into.output += from.output;
  into.cacheRead += from.cacheRead;
  into.cacheWrite += from.cacheWrite;
  into.reasoning += from.reasoning;
  into.total += from.total;
}
