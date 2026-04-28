import { parseClaudeSession } from "../src/parsers/claude.js";

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("usage: tsx scripts/test-parser.ts <session.jsonl>");
    process.exit(1);
  }
  const { session, warnings } = await parseClaudeSession(filePath);
  const counts = { user: 0, assistant: 0, system: 0 };
  const blockCounts: Record<string, number> = {};
  for (const m of session.messages) {
    counts[m.role]++;
    for (const b of m.blocks) blockCounts[b.type] = (blockCounts[b.type] ?? 0) + 1;
  }
  console.log("session id:        ", session.id);
  console.log("model:             ", session.model);
  console.log("cwd:               ", session.workingDirectory);
  console.log("created:           ", session.createdAt);
  console.log("total messages:    ", session.messages.length);
  console.log("by role:           ", counts);
  console.log("by block type:     ", blockCounts);
  if (warnings.length) {
    console.log("warnings:");
    for (const w of warnings) console.log("  -", w);
  }
  if (session.messages.length) {
    console.log("\nfirst message:");
    console.log(JSON.stringify(session.messages[0], null, 2).slice(0, 1500));
    console.log("\nlast message:");
    console.log(JSON.stringify(session.messages.at(-1), null, 2).slice(0, 1500));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
