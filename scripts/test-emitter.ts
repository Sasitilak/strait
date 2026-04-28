import * as fs from "node:fs";
import * as path from "node:path";
import { parseClaudeSession } from "../src/parsers/claude.js";
import { writeCodexSession } from "../src/emitters/codex.js";

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("usage: tsx scripts/test-emitter.ts <claude-session.jsonl>");
    process.exit(1);
  }
  const { session } = await parseClaudeSession(filePath);
  const outputPath = path.join("tmp", `test-output-${Date.now()}.jsonl`);
  fs.mkdirSync("tmp", { recursive: true });
  const result = await writeCodexSession(session, { outputPath });
  console.log("wrote:", result.outputPath);
  console.log("codex sessionId:", result.sessionId);
  console.log("stats:", result.stats);
  console.log("\nfirst 4 lines:");
  const lines = fs.readFileSync(outputPath, "utf8").split("\n").filter(Boolean);
  for (const l of lines.slice(0, 4)) console.log(l);
}
main().catch((e) => { console.error(e); process.exit(1); });
