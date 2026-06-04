import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export const HISTORY_PATH = path.join(os.homedir(), ".strait", "history.jsonl");

export interface HistoryEntry {
  ts: string;
  from: string;
  to: string;
  srcId: string;
  tgtId: string;
  messages: number;
  toolCalls: number;
  dryRun: boolean;
  outputPath: string;
}

export function appendHistory(entry: HistoryEntry): void {
  try {
    fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
    fs.appendFileSync(HISTORY_PATH, JSON.stringify(entry) + "\n");
  } catch {
    // Best-effort — never block a successful sync on logging.
  }
}

export function readHistory(): HistoryEntry[] {
  if (!fs.existsSync(HISTORY_PATH)) return [];
  const out: HistoryEntry[] = [];
  for (const line of fs.readFileSync(HISTORY_PATH, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
  }
  return out;
}
