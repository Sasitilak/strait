import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import chalk from "chalk";
import ora from "ora";
import { select, confirm } from "@inquirer/prompts";
import { parseClaudeSession } from "./parsers/claude.js";
import { parseCodexSession } from "./parsers/codex.js";
import { parseOpencodeSession } from "./parsers/opencode.js";
import { writeCodexSession } from "./emitters/codex.js";
import { writeClaudeSession } from "./emitters/claude.js";
import { ferry } from "./anim.js";
import { listAllClaudeSessions, listAllCodexSessions, listAllOpencodeSessions } from "./discover.js";

type Runtime = "claude" | "codex" | "opencode";

const claudeColor = chalk.hex("#FF8C42");
const codexColor = chalk.hex("#3B82F6");
const opencodeColor = chalk.hex("#A78BFA");
const colorFor = (rt: Runtime) =>
  rt === "claude" ? claudeColor : rt === "codex" ? codexColor : opencodeColor;

interface SessionEntry {
  filePath: string;
  id: string;
  mtime: number;
  preview: string;
  msgCount: number;
}

async function buildEntries(runtime: Runtime, limit: number): Promise<SessionEntry[]> {
  if (runtime === "opencode") {
    const sessions = (await listAllOpencodeSessions()).slice(0, limit);
    return sessions.map((s) => ({
      filePath: s.ref,
      id: s.id,
      mtime: s.mtime,
      preview: s.title.replace(/\s+/g, " ").slice(0, 60),
      msgCount: 0, // skip count to keep listing fast (no full parse)
    }));
  }
  const all = runtime === "claude" ? listAllClaudeSessions() : listAllCodexSessions();
  const files = all
    .map((f) => ({ f, m: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .slice(0, limit);

  const entries: SessionEntry[] = [];
  for (const { f, m } of files) {
    const base = path.basename(f, ".jsonl");
    const id = base.replace(/^rollout-[\d\-T]+-/, "");
    let preview = "";
    let msgCount = 0;
    try {
      const { session } = runtime === "claude"
        ? await parseClaudeSession(f)
        : await parseCodexSession(f);
      msgCount = session.messages.length;
      const firstUser = session.messages.find((x) => x.role === "user");
      const text = firstUser?.blocks.find((b) => b.type === "text");
      if (text && text.type === "text") preview = text.text.replace(/\s+/g, " ").slice(0, 60);
    } catch {
      preview = "[parse error]";
    }
    entries.push({ filePath: f, id, mtime: m, preview, msgCount });
  }
  return entries;
}

async function parseAny(runtime: Runtime, ref: string) {
  if (runtime === "claude") return parseClaudeSession(ref);
  if (runtime === "codex") return parseCodexSession(ref);
  return parseOpencodeSession(ref);
}

export async function runInteractive(): Promise<void> {
  try {
    await runInteractiveLoop();
  } catch (err: any) {
    // @inquirer/prompts throws this on Ctrl-C / Esc. Exit cleanly.
    if (err?.name === "ExitPromptError" || /force closed/i.test(err?.message ?? "")) {
      process.stdout.write("\x1b[?25h"); // restore cursor
      console.log(chalk.dim("\nbye."));
      return;
    }
    throw err;
  }
}

async function runInteractiveLoop(): Promise<void> {
  const banner = `${chalk.bold("strait")}${chalk.dim(" v0.0.1 — session portability for AI agents")}`;
  console.log(banner);
  console.log("");

  while (true) {
    const action = await select({
      message: "What do you want to do?",
      choices: [
        { name: "Sync Claude → Codex", value: "claude->codex" },
        { name: "Sync Codex → Claude", value: "codex->claude" },
        { name: "Sync OpenCode → Claude", value: "opencode->claude" },
        { name: "Sync OpenCode → Codex", value: "opencode->codex" },
        { name: "List recent Claude sessions", value: "list-claude" },
        { name: "List recent Codex sessions", value: "list-codex" },
        { name: "List recent OpenCode sessions", value: "list-opencode" },
        { name: "Quit", value: "quit" },
      ],
    });

    if (action === "quit") { console.log(chalk.dim("bye.")); return; }

    if (action === "list-claude" || action === "list-codex" || action === "list-opencode") {
      const rt: Runtime =
        action === "list-claude" ? "claude" :
        action === "list-codex" ? "codex" : "opencode";
      const sp = ora(`Scanning ${rt} sessions...`).start();
      let entries: SessionEntry[];
      try { entries = await buildEntries(rt, 15); }
      catch (e) { sp.fail((e as Error).message); continue; }
      sp.succeed(`Found ${entries.length} ${rt} sessions`);
      const tint = colorFor(rt);
      for (const e of entries) {
        const date = new Date(e.mtime).toISOString().slice(0, 16).replace("T", " ");
        console.log(`  ${tint(e.id)} ${chalk.dim(date)} ${chalk.dim(`(${e.msgCount} msgs)`)}  ${e.preview}`);
      }
      console.log("");
      continue;
    }

    const [from, to] = action.split("->") as [Runtime, Runtime];
    const sp = ora(`Scanning ${from} sessions...`).start();
    let entries: SessionEntry[];
    try { entries = await buildEntries(from, 15); }
    catch (e) { sp.fail((e as Error).message); continue; }
    sp.succeed(`Found ${entries.length} ${from} sessions`);
    if (!entries.length) {
      console.log(chalk.yellow(`No ${from} sessions to translate.`));
      continue;
    }

    const tint = colorFor(from);
    const choice = await select({
      message: `Pick a ${from} session to translate:`,
      pageSize: 12,
      choices: entries.map((e) => {
        const date = new Date(e.mtime).toISOString().slice(0, 16).replace("T", " ");
        return {
          name: `${tint(e.id.slice(0, 8))}  ${chalk.dim(date)}  ${chalk.dim(`(${e.msgCount} msgs)`)}  ${e.preview}`,
          value: e,
        };
      }),
    });

    const mode = await select({
      message: "Where should the translated session be written?",
      choices: [
        { name: "Dry run — write to ./tmp/ for inspection", value: "dry" },
        { name: `Real — write to the ${to} sessions dir`, value: "real" },
      ],
    });

    const verbose = await confirm({ message: "Show per-message verbose log?", default: false });

    await runSync({ from, to, entry: choice, dryRun: mode === "dry", verbose });

    const again = await confirm({ message: "Do something else?", default: true });
    if (!again) { console.log(chalk.dim("bye.")); return; }
  }
}

async function runSync(opts: {
  from: Runtime; to: Runtime; entry: SessionEntry; dryRun: boolean; verbose: boolean;
}): Promise<void> {
  const { from, to, entry, dryRun, verbose } = opts;
  const lookup = ora(`Reading ${colorFor(from)(entry.id.slice(0, 8))}...`).start();
  let parseRes;
  try {
    parseRes = await parseAny(from, entry.filePath);
  } catch (e) {
    lookup.fail(`Could not parse: ${(e as Error).message}`);
    return;
  }
  lookup.succeed(`Loaded ${parseRes.session.messages.length} messages`);

  let toolCalls = 0, thinkingDrops = 0;
  for (const m of parseRes.session.messages) {
    for (const b of m.blocks) {
      if (b.type === "tool_call") toolCalls++;
      else if (b.type === "thinking") thinkingDrops++;
    }
    if (verbose) {
      const types = m.blocks.map((b) => b.type).join(",");
      console.log(chalk.dim(`  · ${m.role}: ${types}`));
    }
  }
  console.log(chalk.dim(`  ${parseRes.session.messages.length} messages, ${toolCalls} tool calls, ${thinkingDrops} thinking blocks dropped`));
  for (const w of parseRes.warnings) console.log(chalk.yellow.dim(`  ⚠ ${w}`));

  let outputPath: string | undefined;
  if (dryRun) {
    fs.mkdirSync("tmp", { recursive: true });
    outputPath = path.join("tmp", `dry-run-${to}-${Date.now()}.jsonl`);
  }

  let result;
  try {
    const writePromise = to === "codex"
      ? writeCodexSession(parseRes.session, { outputPath })
      : writeClaudeSession(parseRes.session, { outputPath });
    await ferry({ fromLabel: cap(from), toLabel: cap(to) });
    result = await writePromise;
  } catch (e) {
    console.log(chalk.red(`✗ Write failed: ${(e as Error).message}`));
    return;
  }
  const targetTint = colorFor(to);
  console.log(chalk.dim(`  wrote ${targetTint(result.outputPath)}`));
  const resumeCmd = to === "codex"
    ? `codex resume ${targetTint(result.sessionId)}`
    : `claude --resume ${targetTint(result.sessionId)}`;
  console.log("");
  console.log(`${chalk.green("✓")} Done. Resume command: ${chalk.bold(resumeCmd)}`);
  if (dryRun) {
    console.log(chalk.dim(`  (dry-run: copy the file into the ${to} sessions dir to actually resume)`));
    console.log("");
    return;
  }
  const sessionCwd = parseRes.session.workingDirectory ?? process.cwd();

  const next = await select({
    message: "What now?",
    choices: [
      { name: `Run "${resumeCmd}" now (in ${sessionCwd})`, value: "run" },
      { name: "Skip — I'll run it myself later", value: "skip" },
    ],
  });

  if (next === "run") {
    console.log(chalk.dim(`→ launching ${to}...`));
    await runResume(to, result.sessionId, sessionCwd);
  }
  console.log("");
}

async function runResume(to: Runtime, sessionId: string, cwd: string): Promise<void> {
  const cmd = to === "codex" ? "codex" : "claude";
  const args = to === "codex"
    ? ["resume", sessionId]
    : ["--resume", sessionId];

  await new Promise<void>((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit", cwd });
    child.on("exit", () => resolve());
    child.on("error", (err) => {
      console.log(chalk.red(`✗ Could not launch ${cmd}: ${err.message}`));
      resolve();
    });
  });
}

function cap(s: string) { return s.charAt(0).toUpperCase() + s.slice(1); }
