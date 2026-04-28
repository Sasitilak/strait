import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { openDatabase } from "./sqlite.js";
import { OPENCODE_DB, sessionIdToRef } from "./parsers/opencode.js";

const CLAUDE_PROJECTS = path.join(os.homedir(), ".claude", "projects");
const CODEX_SESSIONS = path.join(os.homedir(), ".codex", "sessions");

export interface OpencodeRef {
  ref: string;        // "opencode://<id>"
  id: string;
  directory: string;
  title: string;
  mtime: number;
}

export function listAllClaudeSessions(): string[] {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return [];
  const out: string[] = [];
  for (const proj of fs.readdirSync(CLAUDE_PROJECTS)) {
    const dir = path.join(CLAUDE_PROJECTS, proj);
    let stat: fs.Stats;
    try { stat = fs.statSync(dir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith(".jsonl")) out.push(path.join(dir, f));
    }
  }
  return out;
}

export function listAllCodexSessions(): string[] {
  if (!fs.existsSync(CODEX_SESSIONS)) return [];
  const out: string[] = [];
  walkRollouts(CODEX_SESSIONS, out);
  return out;
}

function walkRollouts(dir: string, out: string[]) {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkRollouts(p, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
}

export function findLatestClaudeSession(): string | null {
  return latestOf(listAllClaudeSessions());
}

export function findLatestCodexSession(): string | null {
  return latestOf(listAllCodexSessions());
}

function latestOf(files: string[]): string | null {
  if (!files.length) return null;
  return files.map((f) => ({ f, m: fs.statSync(f).mtimeMs })).sort((a, b) => b.m - a.m)[0].f;
}

export function findClaudeSessionById(id: string): string | null {
  for (const f of listAllClaudeSessions()) {
    if (path.basename(f, ".jsonl") === id) return f;
  }
  return null;
}

export function findCodexSessionById(id: string): string | null {
  for (const f of listAllCodexSessions()) {
    // Codex rollout filenames are `rollout-<iso>-<uuid>.jsonl`. Match the uuid suffix.
    const base = path.basename(f, ".jsonl");
    if (base === id || base.endsWith(`-${id}`)) return f;
  }
  return null;
}

export async function listAllOpencodeSessions(): Promise<OpencodeRef[]> {
  if (!fs.existsSync(OPENCODE_DB)) return [];
  const db = await openDatabase(OPENCODE_DB);
  try {
    const stmt = db.prepare(
      "SELECT id, directory, title, time_updated FROM session ORDER BY time_updated DESC",
    );
    const out: OpencodeRef[] = [];
    while (stmt.step()) {
      const r = stmt.getAsObject() as any;
      out.push({
        ref: sessionIdToRef(r.id),
        id: r.id,
        directory: r.directory,
        title: r.title,
        mtime: r.time_updated,
      });
    }
    stmt.free();
    return out;
  } finally {
    db.close();
  }
}

export async function findLatestOpencodeRef(): Promise<string | null> {
  const rows = await listAllOpencodeSessions();
  return rows.length ? rows[0].ref : null;
}

export async function findOpencodeRefById(id: string): Promise<string | null> {
  for (const r of await listAllOpencodeSessions()) {
    if (r.id === id) return r.ref;
  }
  return null;
}
