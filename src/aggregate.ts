/**
 * Telemetry aggregation engine.
 *
 * Walks every local session via the existing discovery + parser layer and folds
 * it into a privacy-safe MetadataSnapshot. It is a pure *consumer* of the IR —
 * it never touches raw JSONL/SQLite, and never reads message text or tool
 * arguments. Adding token usage was the only IR change; everything else here is
 * read-only over `Session.messages[].blocks[]`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import type { Session, TokenUsage } from "./ir.js";
import {
  type MetadataSnapshot,
  type Runtime,
  type RuntimeBreakdown,
  type ActivityDay,
  SNAPSHOT_SCHEMA_VERSION,
  mcpServerOf,
  emptyUsage,
  addUsage,
} from "./analytics.js";
import { VERSION } from "./version.js";
import {
  listAllClaudeSessions,
  listAllCodexSessions,
  listAllOpencodeSessions,
} from "./discover.js";
import { parseClaudeSession } from "./parsers/claude.js";
import { parseCodexSession } from "./parsers/codex.js";
import { parseOpencodeSession, OPENCODE_DB } from "./parsers/opencode.js";

const ALL_RUNTIMES: Runtime[] = ["claude", "codex", "opencode"];
const CLAUDE_SKILLS_DIR = path.join(os.homedir(), ".claude", "skills");

export interface AggregateOptions {
  runtimes?: Runtime[];
  since?: string; // "YYYY-MM-DD" lower bound on session activity
  concurrency?: number; // default 8
  onProgress?: (done: number, total: number) => void;
}

interface DayAcc { sessions: number; messages: number; toolCalls: number; tokens: number; }

interface Accumulator {
  toolCounts: Map<string, number>;
  mcpServerCounts: Map<string, number>;
  modelCounts: Map<string, number>;
  tokenTotals: TokenUsage;
  byRuntime: Map<Runtime, RuntimeBreakdown>;
  byDay: Map<string, DayAcc>;
  byWeekday: number[]; // length 7, local
  byHour: number[]; // length 24, local
  projects: Set<string>;
  totalSessions: number;
  totalMessages: number;
  totalToolCalls: number;
}

/** Pure reducer over an already-parsed session — no I/O, unit-testable. */
export function foldSession(acc: Accumulator, session: Session): void {
  const rt = session.sourceRuntime;
  const day = (session.createdAt || "").slice(0, 10) || "unknown";
  const dayAcc = getDay(acc.byDay, day);
  const rb = getRuntime(acc.byRuntime, rt);

  acc.totalSessions++;
  rb.sessions++;
  dayAcc.sessions++;

  if (session.model) inc(acc.modelCounts, session.model);

  if (session.workingDirectory) {
    acc.projects.add(hashBasename(session.workingDirectory));
  }

  if (session.usage) {
    addUsage(acc.tokenTotals, session.usage);
    addUsage(rb.tokens, session.usage);
    dayAcc.tokens += session.usage.total;
  }

  for (const m of session.messages) {
    acc.totalMessages++;
    rb.messages++;
    dayAcc.messages++;
    // Bucket the message into local weekday/hour histograms.
    const ms = Date.parse(m.timestamp);
    if (!Number.isNaN(ms)) {
      const d = new Date(ms);
      acc.byWeekday[d.getDay()]++;
      acc.byHour[d.getHours()]++;
    }
    for (const b of m.blocks) {
      if (b.type !== "tool_call") continue;
      acc.totalToolCalls++;
      rb.toolCalls++;
      dayAcc.toolCalls++;
      inc(acc.toolCounts, b.name);
      const server = mcpServerOf(b.name);
      if (server) inc(acc.mcpServerCounts, server);
    }
  }
}

export async function buildSnapshot(opts: AggregateOptions = {}): Promise<MetadataSnapshot> {
  const runtimes = opts.runtimes?.length ? opts.runtimes : ALL_RUNTIMES;
  const sinceMs = opts.since ? Date.parse(opts.since) : NaN;
  const concurrency = opts.concurrency && opts.concurrency > 0 ? opts.concurrency : 8;

  // Build the worklist of lazy parse thunks. File-backed runtimes get a cheap
  // mtime pre-filter so cold sessions are skipped without being parsed.
  const tasks: Array<() => Promise<Session | null>> = [];

  if (runtimes.includes("claude")) {
    for (const f of listAllClaudeSessions()) {
      if (skipByMtime(f, sinceMs)) continue;
      tasks.push(async () => (await parseClaudeSession(f)).session);
    }
  }
  if (runtimes.includes("codex")) {
    for (const f of listAllCodexSessions()) {
      if (skipByMtime(f, sinceMs)) continue;
      tasks.push(async () => (await parseCodexSession(f)).session);
    }
  }
  if (runtimes.includes("opencode") && fs.existsSync(OPENCODE_DB)) {
    for (const r of await listAllOpencodeSessions()) {
      if (!Number.isNaN(sinceMs) && r.mtime < sinceMs) continue;
      tasks.push(async () => (await parseOpencodeSession(r.ref)).session);
    }
  }

  const acc: Accumulator = {
    toolCounts: new Map(),
    mcpServerCounts: new Map(),
    modelCounts: new Map(),
    tokenTotals: emptyUsage(),
    byRuntime: new Map(),
    byDay: new Map(),
    byWeekday: new Array(7).fill(0),
    byHour: new Array(24).fill(0),
    projects: new Set(),
    totalSessions: 0,
    totalMessages: 0,
    totalToolCalls: 0,
  };

  const total = tasks.length;
  let done = 0;
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      try {
        const session = await tasks[i]();
        if (session && passesSince(session, sinceMs)) foldSession(acc, session);
      } catch {
        // A single unreadable/corrupt session must not sink the whole run.
      }
      opts.onProgress?.(++done, total);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));

  return finalize(acc, runtimes);
}

function finalize(acc: Accumulator, runtimes: Runtime[]): MetadataSnapshot {
  const activity: ActivityDay[] = [...acc.byDay.entries()]
    .filter(([d]) => d !== "unknown")
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, d]) => ({ date, sessions: d.sessions, messages: d.messages, toolCalls: d.toolCalls, tokens: d.tokens }));

  const runtimeBreakdown = runtimes
    .map((rt) => acc.byRuntime.get(rt))
    .filter((rb): rb is RuntimeBreakdown => !!rb);

  const skillUsage = readInstalledSkills();

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    generatedBy: `strait-cli@${VERSION}`,
    toolCounts: sortedRecord(acc.toolCounts),
    mcpServerCounts: sortedRecord(acc.mcpServerCounts),
    skillUsage,
    modelCounts: sortedRecord(acc.modelCounts),
    tokenTotals: acc.tokenTotals,
    runtimeBreakdown,
    activity,
    timePatterns: { byWeekday: acc.byWeekday, byHour: acc.byHour },
    totals: {
      sessions: acc.totalSessions,
      messages: acc.totalMessages,
      toolCalls: acc.totalToolCalls,
      distinctTools: acc.toolCounts.size,
      distinctMcpServers: acc.mcpServerCounts.size,
      distinctSkills: Object.keys(skillUsage).length,
      firstActivity: activity.length ? activity[0].date : null,
      lastActivity: activity.length ? activity[activity.length - 1].date : null,
    },
    projectCount: acc.projects.size,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function getDay(m: Map<string, DayAcc>, day: string): DayAcc {
  let d = m.get(day);
  if (!d) { d = { sessions: 0, messages: 0, toolCalls: 0, tokens: 0 }; m.set(day, d); }
  return d;
}

function getRuntime(m: Map<Runtime, RuntimeBreakdown>, rt: Runtime): RuntimeBreakdown {
  let rb = m.get(rt);
  if (!rb) { rb = { runtime: rt, sessions: 0, messages: 0, toolCalls: 0, tokens: emptyUsage() }; m.set(rt, rb); }
  return rb;
}

function inc(m: Map<string, number>, k: string): void {
  m.set(k, (m.get(k) ?? 0) + 1);
}

function sortedRecord(m: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of [...m.entries()].sort((a, b) => b[1] - a[1])) out[k] = v;
  return out;
}

/** Hash the cwd's basename so the snapshot can count distinct projects without leaking paths. */
function hashBasename(cwd: string): string {
  const base = path.basename(cwd) || cwd;
  return createHash("sha256").update(base).digest("hex").slice(0, 12);
}

function skipByMtime(file: string, sinceMs: number): boolean {
  if (Number.isNaN(sinceMs)) return false;
  try { return fs.statSync(file).mtimeMs < sinceMs; } catch { return false; }
}

function passesSince(session: Session, sinceMs: number): boolean {
  if (Number.isNaN(sinceMs)) return true;
  const t = Date.parse(session.createdAt);
  return Number.isNaN(t) || t >= sinceMs;
}

/**
 * Installed Claude Code skills, read from ~/.claude/skills/<name>/SKILL.md.
 * Only the skill's name is read (the directory name, or the frontmatter `name:`
 * if present) — never the body. Value 1 marks "installed". See the skillUsage
 * note in analytics.ts for why this is inventory, not usage.
 */
function readInstalledSkills(): Record<string, number> {
  const out: Record<string, number> = {};
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(CLAUDE_SKILLS_DIR, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const skillFile = path.join(CLAUDE_SKILLS_DIR, e.name, "SKILL.md");
    if (!fs.existsSync(skillFile)) continue;
    out[frontmatterName(skillFile) ?? e.name] = 1;
  }
  return out;
}

function frontmatterName(file: string): string | null {
  try {
    // Read only the head of the file; frontmatter is at the very top.
    const head = fs.readFileSync(file, "utf8").slice(0, 2048);
    // Isolate the `---` … `---` block first so a `name:` in the body can't leak.
    const fence = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
    if (!fence) return null;
    const m = /^name:\s*(.+?)\s*$/m.exec(fence[1]);
    return m ? m[1].replace(/^["']|["']$/g, "") : null;
  } catch {
    return null;
  }
}
