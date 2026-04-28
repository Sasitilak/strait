import { defineCommand, runMain } from "citty";
import chalk from "chalk";
import ora from "ora";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseClaudeSession } from "./parsers/claude.js";
import { parseCodexSession } from "./parsers/codex.js";
import { parseOpencodeSession } from "./parsers/opencode.js";
import { writeCodexSession } from "./emitters/codex.js";
import { writeClaudeSession } from "./emitters/claude.js";
import { runInteractive } from "./interactive.js";
import { ferry } from "./anim.js";
import {
  listAllClaudeSessions,
  findLatestClaudeSession,
  findClaudeSessionById,
  listAllCodexSessions,
  findLatestCodexSession,
  findCodexSessionById,
  listAllOpencodeSessions,
  findLatestOpencodeRef,
  findOpencodeRefById,
} from "./discover.js";

const VERSION = "0.0.1";
const BANNER = `${chalk.bold("strait")}${chalk.dim(` v${VERSION} — session portability for AI agents`)}`;

const claudeColor = chalk.hex("#FF8C42");
const codexColor = chalk.hex("#3B82F6");
const opencodeColor = chalk.hex("#A78BFA");
const colorForRuntime = (rt: string) =>
  rt === "claude" ? claudeColor :
  rt === "codex" ? codexColor :
  rt === "opencode" ? opencodeColor :
  chalk.cyan;

function reportError(spinner: ReturnType<typeof ora> | null, err: unknown, msg: string): never {
  const detail = err instanceof Error ? err.message : String(err);
  if (spinner) spinner.fail(`${msg}: ${detail}`);
  else console.error(chalk.red(`${msg}: ${detail}`));
  if (process.env.DEBUG === "1" && err instanceof Error) console.error(err.stack);
  process.exit(1);
}

const sync = defineCommand({
  meta: { name: "sync", description: "Translate a session between two runtimes" },
  args: {
    from: { type: "positional", required: true, description: "source: claude | codex" },
    to: { type: "positional", required: true, description: "target: claude | codex" },
    session: { type: "string", description: "specific source session UUID" },
    latest: { type: "boolean", description: "use most recent source session" },
    "dry-run": { type: "boolean", description: "write to ./tmp/ instead of the real target dir" },
    verbose: { type: "boolean", description: "log each translation step" },
  },
  async run({ args }) {
    console.log(BANNER);
    const validDirs = new Set([
      "claude->codex", "codex->claude",
      "opencode->claude", "opencode->codex",
    ]);
    const dir = `${args.from}->${args.to}`;
    if (!validDirs.has(dir)) {
      console.error(chalk.red(`Supported directions: claude↔codex, opencode→claude, opencode→codex`));
      process.exit(1);
    }

    const lookup = ora(`Looking up ${args.from} session...`).start();
    let filePath: string | null = null;
    try {
      if (args.session) {
        filePath =
          args.from === "claude" ? findClaudeSessionById(String(args.session)) :
          args.from === "codex" ? findCodexSessionById(String(args.session)) :
          await findOpencodeRefById(String(args.session));
        if (!filePath) { lookup.fail(`Session not found: ${args.session}`); process.exit(1); }
      } else if (args.latest) {
        filePath =
          args.from === "claude" ? findLatestClaudeSession() :
          args.from === "codex" ? findLatestCodexSession() :
          await findLatestOpencodeRef();
        if (!filePath) { lookup.fail(`No ${args.from} sessions found`); process.exit(1); }
      } else {
        lookup.fail("Pass --latest or --session <id>");
        process.exit(1);
      }
    } catch (e) { reportError(lookup, e, "Lookup failed"); }

    let parseRes;
    try {
      parseRes =
        args.from === "claude" ? await parseClaudeSession(filePath!) :
        args.from === "codex" ? await parseCodexSession(filePath!) :
        await parseOpencodeSession(filePath!);
    } catch (e) { reportError(lookup, e, "Couldn't parse session"); }
    const srcId = args.from === "opencode"
      ? filePath!.replace(/^opencode:\/\//, "")
      : path.basename(filePath!, ".jsonl");
    const created = parseRes!.session.createdAt.slice(0, 10);
    const srcTint = colorForRuntime(args.from);
    lookup.succeed(
      `Found: ${srcTint(srcId)} ${chalk.dim(`(${parseRes!.session.messages.length} messages, ${created})`)}`,
    );

    const fromLabel = cap(args.from);
    const toLabel = cap(args.to);
    const translate = ora(`Translating ${fromLabel} → ${toLabel}...`).start();
    let toolCalls = 0, thinkingDrops = 0;
    for (const m of parseRes!.session.messages) {
      for (const b of m.blocks) {
        if (b.type === "tool_call") toolCalls++;
        else if (b.type === "thinking") thinkingDrops++;
      }
      if (args.verbose) {
        const types = m.blocks.map((b) => b.type).join(",");
        console.log(chalk.dim(`  · ${m.role}: ${types}`));
      }
    }
    translate.succeed(
      `Translated ${parseRes!.session.messages.length} messages ${chalk.dim("↦")} ${toolCalls} tool calls`,
    );

    if (thinkingDrops || parseRes!.warnings.length) {
      if (thinkingDrops) console.log(chalk.yellow.dim(`  ⚠ dropped ${thinkingDrops} thinking blocks`));
      for (const w of parseRes!.warnings) console.log(chalk.yellow.dim(`  ⚠ ${w}`));
    }

    let outputPath: string | undefined;
    if (args["dry-run"]) {
      fs.mkdirSync("tmp", { recursive: true });
      outputPath = path.join("tmp", `dry-run-${args.to}-${Date.now()}.jsonl`);
    }

    let result;
    try {
      const writePromise = args.to === "codex"
        ? writeCodexSession(parseRes!.session, { outputPath })
        : writeClaudeSession(parseRes!.session, { outputPath });
      await ferry({ fromLabel, toLabel });
      result = await writePromise;
    } catch (e) { reportError(null, e, "Write failed"); }
    const tgtTint = colorForRuntime(args.to);
    console.log(chalk.dim(`  wrote ${tgtTint(result!.outputPath)}`));

    const resumeCmd = args.to === "codex"
      ? `codex resume ${tgtTint(result!.sessionId)}`
      : `claude --resume ${tgtTint(result!.sessionId)}`;
    console.log("");
    console.log(`${chalk.green("✓")} Done. Resume with: ${chalk.bold(resumeCmd)}`);
    if (args["dry-run"]) {
      console.log(chalk.dim(`  (dry-run: not in the real target dir, copy it there to actually resume)`));
    }
  },
});

const list = defineCommand({
  meta: { name: "list", description: "List sessions" },
  args: { runtime: { type: "positional", required: true, description: "runtime: claude | codex | opencode" } },
  async run({ args }) {
    console.log(BANNER);
    const rt = args.runtime;
    if (rt !== "claude" && rt !== "codex" && rt !== "opencode") {
      console.error(chalk.red("usage: strait list claude | codex | opencode"));
      process.exit(1);
    }
    const listTint = colorForRuntime(rt);

    if (rt === "opencode") {
      const sessions = (await listAllOpencodeSessions()).slice(0, 10);
      if (!sessions.length) { console.error(chalk.yellow("No OpenCode sessions found.")); return; }
      for (const s of sessions) {
        const date = new Date(s.mtime).toISOString().slice(0, 16).replace("T", " ");
        const title = s.title.replace(/\s+/g, " ").slice(0, 60);
        console.log(`${listTint(s.id)} ${chalk.dim(date)}  ${title}`);
      }
      return;
    }

    const files = rt === "claude" ? listAllClaudeSessions() : listAllCodexSessions();
    if (!files.length) {
      console.error(chalk.yellow(`No ${rt} sessions found.`));
      return;
    }
    const ranked = files
      .map((f) => ({ f, m: fs.statSync(f).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .slice(0, 10);

    for (const { f, m } of ranked) {
      const id = path.basename(f, ".jsonl").replace(/^rollout-[\d\-T]+-/, "");
      const date = new Date(m).toISOString().slice(0, 16).replace("T", " ");
      let preview = "";
      let count = 0;
      try {
        const { session } = rt === "claude" ? await parseClaudeSession(f) : await parseCodexSession(f);
        count = session.messages.length;
        const firstUser = session.messages.find((x) => x.role === "user");
        const text = firstUser?.blocks.find((b) => b.type === "text");
        if (text && text.type === "text") preview = text.text.replace(/\s+/g, " ").slice(0, 60);
      } catch {
        preview = chalk.red("[parse error]");
      }
      console.log(`${listTint(id)} ${chalk.dim(date)} ${chalk.dim(`(${count} msgs)`)}  ${preview}`);
    }
  },
});

const main = defineCommand({
  meta: { name: "strait", version: VERSION, description: "Move AI agent sessions between Claude Code and Codex" },
  subCommands: { sync, list },
  async run({ args }) {
    if (args._?.length) return;
    if (!process.stdin.isTTY) {
      console.log(BANNER);
      console.log("");
      console.log("Commands:");
      console.log("  strait sync claude codex --latest [--dry-run] [--verbose]");
      console.log("  strait sync codex claude --latest [--dry-run] [--verbose]");
      console.log("  strait sync opencode claude|codex --latest");
      console.log("  strait sync <from> <to> --session <id>");
      console.log("  strait list claude | codex | opencode");
      console.log("");
      console.log(`Run ${chalk.cyan("strait")} in a TTY for interactive mode.`);
      return;
    }
    await runInteractive();
  },
});

function cap(s: string) { return s.charAt(0).toUpperCase() + s.slice(1); }

runMain(main);
