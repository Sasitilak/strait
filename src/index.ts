import { defineCommand, runMain } from "citty";
import chalk from "chalk";
import ora from "ora";
import { select } from "@inquirer/prompts";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseClaudeSession } from "./parsers/claude.js";
import { parseCodexSession } from "./parsers/codex.js";
import { parseOpencodeSession } from "./parsers/opencode.js";
import { writeCodexSession } from "./emitters/codex.js";
import { writeClaudeSession } from "./emitters/claude.js";
import { writeOpencodeSession } from "./emitters/opencode.js";
import { runInteractive } from "./interactive.js";
import { ferry } from "./anim.js";
import { VERSION } from "./version.js";
import { appendHistory, readHistory, HISTORY_PATH } from "./history.js";
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
    from: { type: "positional", required: true, description: "source: claude | codex | opencode" },
    to: { type: "positional", required: true, description: "target: claude | codex | opencode" },
    session: { type: "string", description: "specific source session UUID" },
    latest: { type: "boolean", description: "use most recent source session" },
    "dry-run": { type: "boolean", description: "write to ./tmp/ instead of the real target dir" },
    verbose: { type: "boolean", description: "log each translation step" },
    force: { type: "boolean", description: "skip OpenCode-running safety check (dangerous)" },
  },
  async run({ args }) {
    console.log(BANNER);
    const validDirs = new Set([
      "claude->codex", "codex->claude",
      "opencode->claude", "opencode->codex",
      "claude->opencode", "codex->opencode",
    ]);
    const dir = `${args.from}->${args.to}`;
    if (!validDirs.has(dir)) {
      console.error(chalk.red(`Supported directions: claude↔codex, claude↔opencode, codex↔opencode`));
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
      const ext = args.to === "opencode" ? "db" : "jsonl";
      outputPath = path.join("tmp", `dry-run-${args.to}-${Date.now()}.${ext}`);
      // For OpenCode dry-run, seed the tmp file from the real DB so the
      // emitter has the schema + project_id to insert against.
      if (args.to === "opencode") {
        const real = path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
        if (fs.existsSync(real)) fs.copyFileSync(real, outputPath);
      }
    }

    let result;
    try {
      const writePromise =
        args.to === "codex" ? writeCodexSession(parseRes!.session, { outputPath }) :
        args.to === "claude" ? writeClaudeSession(parseRes!.session, { outputPath }) :
        writeOpencodeSession(parseRes!.session, { outputPath, force: !!args.force });
      await ferry({ fromLabel, toLabel });
      result = await writePromise;
    } catch (e) { reportError(null, e, "Write failed"); }
    const tgtTint = colorForRuntime(args.to);
    console.log(chalk.dim(`  wrote ${tgtTint(result!.outputPath)}`));

    appendHistory({
      ts: new Date().toISOString(),
      from: args.from,
      to: args.to,
      srcId,
      tgtId: result!.sessionId,
      messages: parseRes!.session.messages.length,
      toolCalls,
      dryRun: !!args["dry-run"],
      outputPath: result!.outputPath,
    });

    const resumeCmd =
      args.to === "codex" ? `codex resume ${tgtTint(result!.sessionId)}` :
      args.to === "claude" ? `claude --resume ${tgtTint(result!.sessionId)}` :
      `opencode --session ${tgtTint(result!.sessionId)}`;
    console.log("");
    console.log(`${chalk.green("✓")} Done. Resume with: ${chalk.bold(resumeCmd)}`);
    console.log(chalk.dim(`  session id: ${tgtTint(result!.sessionId)}`));
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

function resumeCommandFor(rt: string, id: string): { cmd: string; args: string[] } | null {
  if (rt === "claude") return { cmd: "claude", args: ["--resume", id] };
  if (rt === "codex") return { cmd: "codex", args: ["resume", id] };
  if (rt === "opencode") return { cmd: "opencode", args: ["--session", id] };
  return null;
}

async function pickAndResume(
  rows: { rt: string; id: string; label: string }[],
  promptMsg = "Pick a session to resume",
): Promise<void> {
  if (!rows.length) return;
  if (!process.stdin.isTTY) {
    console.log(chalk.dim("\n(run in a TTY to pick and resume one of these)"));
    return;
  }
  let choice: string;
  try {
    choice = await select({
      message: promptMsg,
      choices: [
        ...rows.map((r) => ({ name: r.label, value: `${r.rt}:${r.id}` })),
        { name: chalk.dim("cancel"), value: "__cancel__" },
      ],
      pageSize: Math.min(15, rows.length + 1),
    });
  } catch { return; } // ctrl-c
  if (choice === "__cancel__") return;
  const [rt, id] = choice.split(":");
  const r = resumeCommandFor(rt, id);
  if (!r) return;
  console.log(chalk.dim(`\n→ ${r.cmd} ${r.args.join(" ")}\n`));
  const child = spawn(r.cmd, r.args, { stdio: "inherit" });
  await new Promise<void>((resolve) => {
    child.on("exit", () => resolve());
    child.on("error", (e) => {
      console.error(chalk.red(`Failed to launch ${r.cmd}: ${(e as Error).message}`));
      console.error(chalk.dim(`Is "${r.cmd}" installed and on your PATH?`));
      resolve();
    });
  });
}

function dirSize(p: string): number {
  let total = 0;
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const sub = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(sub);
      else if (e.isFile()) { try { total += fs.statSync(sub).size; } catch {} }
    }
  }
  return total;
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

const CLAUDE_DIR = path.join(os.homedir(), ".claude", "projects");
const CODEX_DIR = path.join(os.homedir(), ".codex", "sessions");
const OPENCODE_DIR = path.join(os.homedir(), ".local", "share", "opencode");

const status = defineCommand({
  meta: { name: "status", description: "Show what's installed and where sessions live" },
  async run() {
    console.log(BANNER);
    console.log("");

    const claudeFiles = listAllClaudeSessions();
    const codexFiles = listAllCodexSessions();
    const opencodeRows = fs.existsSync(path.join(OPENCODE_DIR, "opencode.db"))
      ? await listAllOpencodeSessions()
      : [];

    const rows = [
      {
        rt: "claude", dir: CLAUDE_DIR, present: fs.existsSync(CLAUDE_DIR),
        sessions: claudeFiles.length,
        latest: claudeFiles.length ? Math.max(...claudeFiles.map((f) => fs.statSync(f).mtimeMs)) : 0,
        size: fs.existsSync(CLAUDE_DIR) ? dirSize(CLAUDE_DIR) : 0,
      },
      {
        rt: "codex", dir: CODEX_DIR, present: fs.existsSync(CODEX_DIR),
        sessions: codexFiles.length,
        latest: codexFiles.length ? Math.max(...codexFiles.map((f) => fs.statSync(f).mtimeMs)) : 0,
        size: fs.existsSync(CODEX_DIR) ? dirSize(CODEX_DIR) : 0,
      },
      {
        rt: "opencode", dir: OPENCODE_DIR, present: fs.existsSync(OPENCODE_DIR),
        sessions: opencodeRows.length,
        latest: opencodeRows.length ? opencodeRows[0].mtime : 0,
        size: fs.existsSync(OPENCODE_DIR) ? dirSize(OPENCODE_DIR) : 0,
      },
    ];

    for (const r of rows) {
      const tint = colorForRuntime(r.rt);
      const mark = r.present ? chalk.green("●") : chalk.dim("○");
      const head = `${mark} ${tint(cap(r.rt).padEnd(9))}`;
      if (!r.present) {
        console.log(`${head} ${chalk.dim("not installed")}  ${chalk.dim(r.dir)}`);
        continue;
      }
      const last = r.latest ? new Date(r.latest).toISOString().slice(0, 16).replace("T", " ") : "—";
      console.log(
        `${head} ${chalk.bold(String(r.sessions).padStart(5))} sessions  ` +
        `${chalk.dim("latest")} ${last}  ` +
        `${chalk.dim("size")} ${humanBytes(r.size).padStart(8)}  ` +
        `${chalk.dim(r.dir)}`,
      );
    }

    const hist = readHistory();
    console.log("");
    console.log(`${chalk.dim("conversions logged:")} ${chalk.bold(String(hist.length))}  ${chalk.dim(HISTORY_PATH)}`);
  },
});

interface UnifiedRow { rt: string; id: string; mtime: number; preview: string; messages: number; }

async function gatherAllSessions(): Promise<UnifiedRow[]> {
  const rows: UnifiedRow[] = [];
  for (const f of listAllClaudeSessions()) {
    let mtime = 0; try { mtime = fs.statSync(f).mtimeMs; } catch {}
    rows.push({ rt: "claude", id: path.basename(f, ".jsonl"), mtime, preview: "", messages: 0 });
  }
  for (const f of listAllCodexSessions()) {
    let mtime = 0; try { mtime = fs.statSync(f).mtimeMs; } catch {}
    const base = path.basename(f, ".jsonl");
    const id = base.replace(/^rollout-[\d\-T]+-/, "");
    rows.push({ rt: "codex", id, mtime, preview: "", messages: 0 });
  }
  if (fs.existsSync(path.join(OPENCODE_DIR, "opencode.db"))) {
    for (const r of await listAllOpencodeSessions()) {
      rows.push({ rt: "opencode", id: r.id, mtime: r.mtime, preview: r.title ?? "", messages: 0 });
    }
  }
  return rows.sort((a, b) => b.mtime - a.mtime);
}

const listAll = defineCommand({
  meta: { name: "list-all", description: "Merge sessions from every runtime, newest first" },
  args: { limit: { type: "string", description: "max rows (default 20)" } },
  async run({ args }) {
    console.log(BANNER);
    const rows = await gatherAllSessions();
    if (!rows.length) { console.log(chalk.yellow("No sessions found in any runtime.")); return; }
    const limit = Number(args.limit) > 0 ? Number(args.limit) : 20;
    const shown = rows.slice(0, limit);
    for (const r of shown) {
      const tint = colorForRuntime(r.rt);
      const when = r.mtime ? new Date(r.mtime).toISOString().slice(0, 16).replace("T", " ") : "—";
      const preview = r.preview.replace(/\s+/g, " ").slice(0, 50);
      console.log(`${tint(cap(r.rt).padEnd(9))} ${chalk.dim(when)}  ${tint(r.id.slice(0, 12))}${chalk.dim("…")}  ${chalk.dim(preview)}`);
    }
    console.log(chalk.dim(`\n${rows.length} total across all runtimes`));
    await pickAndResume(
      shown.map((r) => {
        const tint = colorForRuntime(r.rt);
        const when = r.mtime ? new Date(r.mtime).toISOString().slice(0, 16).replace("T", " ") : "—";
        const preview = r.preview.replace(/\s+/g, " ").slice(0, 50);
        return { rt: r.rt, id: r.id, label: `${tint(cap(r.rt).padEnd(9))} ${chalk.dim(when)}  ${preview || chalk.dim(r.id.slice(0, 12) + "…")}` };
      }),
    );
  },
});

function firstUserText(rt: string, filePath: string): string | null {
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(32 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const head = buf.slice(0, n).toString("utf8");
    for (const line of head.split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (rt === "claude" && obj.type === "user" && obj.message?.content) {
          const c = obj.message.content;
          if (typeof c === "string") return c;
          if (Array.isArray(c)) {
            const t = c.find((b: any) => b.type === "text");
            if (t?.text) return t.text;
          }
        }
        if (rt === "codex" && obj.type === "message" && obj.role === "user") {
          const t = (obj.content ?? []).find((b: any) => b.type === "input_text" || b.type === "text");
          if (t?.text) return t.text;
        }
      } catch { /* not JSON, skip */ }
    }
  } catch { /* unreadable */ }
  return null;
}

const search = defineCommand({
  meta: { name: "search", description: "Search the first user message of every session" },
  args: {
    query: { type: "positional", required: true, description: "case-insensitive substring" },
    limit: { type: "string", description: "max matches (default 20)" },
  },
  async run({ args }) {
    console.log(BANNER);
    const q = String(args.query).toLowerCase();
    const limit = Number(args.limit) > 0 ? Number(args.limit) : 20;
    const hits: { rt: string; id: string; mtime: number; preview: string }[] = [];

    for (const f of listAllClaudeSessions()) {
      const text = firstUserText("claude", f);
      if (text && text.toLowerCase().includes(q)) {
        hits.push({ rt: "claude", id: path.basename(f, ".jsonl"), mtime: fs.statSync(f).mtimeMs, preview: text });
      }
    }
    for (const f of listAllCodexSessions()) {
      const text = firstUserText("codex", f);
      if (text && text.toLowerCase().includes(q)) {
        const id = path.basename(f, ".jsonl").replace(/^rollout-[\d\-T]+-/, "");
        hits.push({ rt: "codex", id, mtime: fs.statSync(f).mtimeMs, preview: text });
      }
    }
    if (fs.existsSync(path.join(OPENCODE_DIR, "opencode.db"))) {
      for (const r of await listAllOpencodeSessions()) {
        if ((r.title ?? "").toLowerCase().includes(q)) {
          hits.push({ rt: "opencode", id: r.id, mtime: r.mtime, preview: r.title });
        }
      }
    }

    hits.sort((a, b) => b.mtime - a.mtime);
    if (!hits.length) { console.log(chalk.yellow(`No matches for "${q}".`)); return; }
    const shown = hits.slice(0, limit);
    for (const h of shown) {
      const tint = colorForRuntime(h.rt);
      const when = new Date(h.mtime).toISOString().slice(0, 16).replace("T", " ");
      const preview = h.preview.replace(/\s+/g, " ").slice(0, 70);
      console.log(`${tint(cap(h.rt).padEnd(9))} ${chalk.dim(when)}  ${tint(h.id.slice(0, 12))}${chalk.dim("…")}  ${preview}`);
    }
    if (hits.length > limit) console.log(chalk.dim(`\n…and ${hits.length - limit} more.`));
    await pickAndResume(
      shown.map((h) => {
        const tint = colorForRuntime(h.rt);
        const when = new Date(h.mtime).toISOString().slice(0, 16).replace("T", " ");
        const preview = h.preview.replace(/\s+/g, " ").slice(0, 70);
        return { rt: h.rt, id: h.id, label: `${tint(cap(h.rt).padEnd(9))} ${chalk.dim(when)}  ${preview}` };
      }),
      `Resume one of these matches for "${q}"?`,
    );
  },
});

const open = defineCommand({
  meta: { name: "open", description: "Find a session by ID and resume it" },
  args: {
    id: { type: "positional", required: true, description: "session id (full or prefix)" },
    "print-only": { type: "boolean", description: "print the resume command instead of launching" },
  },
  async run({ args }) {
    console.log(BANNER);
    const id = String(args.id);
    let hit: { rt: string; id: string; meta: string } | null = null;

    const claudeHit = listAllClaudeSessions().find((f) => path.basename(f, ".jsonl").startsWith(id));
    if (claudeHit) {
      hit = { rt: "claude", id: path.basename(claudeHit, ".jsonl"), meta: claudeHit };
    } else {
      const codexHit = listAllCodexSessions().find((f) => path.basename(f, ".jsonl").includes(id));
      if (codexHit) {
        const sid = path.basename(codexHit, ".jsonl").replace(/^rollout-[\d\-T]+-/, "");
        hit = { rt: "codex", id: sid, meta: codexHit };
      } else if (fs.existsSync(path.join(OPENCODE_DIR, "opencode.db"))) {
        const ocHit = (await listAllOpencodeSessions()).find((r) => r.id.startsWith(id));
        if (ocHit) hit = { rt: "opencode", id: ocHit.id, meta: ocHit.title ?? "" };
      }
    }

    if (!hit) {
      console.log(chalk.red(`No session found matching "${id}" in any runtime.`));
      process.exit(1);
    }

    const r = resumeCommandFor(hit.rt, hit.id)!;
    const tint = colorForRuntime(hit.rt);
    console.log(`${tint(cap(hit.rt))}  ${chalk.bold(`${r.cmd} ${r.args.join(" ")}`)}`);
    if (hit.meta) console.log(chalk.dim(`  ${hit.meta}`));

    if (args["print-only"] || !process.stdin.isTTY) return;
    console.log("");
    const child = spawn(r.cmd, r.args, { stdio: "inherit" });
    await new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
      child.on("error", (e) => {
        console.error(chalk.red(`Failed to launch ${r.cmd}: ${(e as Error).message}`));
        console.error(chalk.dim(`Is "${r.cmd}" installed and on your PATH?`));
        resolve();
      });
    });
  },
});

const stats = defineCommand({
  meta: { name: "stats", description: "Aggregate counts across all runtimes" },
  async run() {
    console.log(BANNER);
    const claudeFiles = listAllClaudeSessions();
    const codexFiles = listAllCodexSessions();
    const opencodeRows = fs.existsSync(path.join(OPENCODE_DIR, "opencode.db"))
      ? await listAllOpencodeSessions()
      : [];
    const hist = readHistory();

    const total = claudeFiles.length + codexFiles.length + opencodeRows.length;
    console.log("");
    console.log(`${chalk.bold("sessions")}`);
    console.log(`  ${claudeColor("claude")}   ${chalk.bold(String(claudeFiles.length).padStart(6))}`);
    console.log(`  ${codexColor("codex")}    ${chalk.bold(String(codexFiles.length).padStart(6))}`);
    console.log(`  ${opencodeColor("opencode")} ${chalk.bold(String(opencodeRows.length).padStart(6))}`);
    console.log(`  ${chalk.dim("total")}    ${chalk.bold(String(total).padStart(6))}`);

    console.log("");
    console.log(`${chalk.bold("conversions")} ${chalk.dim(`(${hist.length} total)`)}`);
    if (hist.length) {
      const byDir: Record<string, number> = {};
      let totalMsgs = 0, totalTools = 0;
      for (const e of hist) {
        const k = `${e.from}->${e.to}`;
        byDir[k] = (byDir[k] ?? 0) + 1;
        totalMsgs += e.messages;
        totalTools += e.toolCalls;
      }
      for (const [k, n] of Object.entries(byDir).sort((a, b) => b[1] - a[1])) {
        const [f, t] = k.split("->");
        console.log(`  ${colorForRuntime(f)(f)} ${chalk.dim("→")} ${colorForRuntime(t)(t)}  ${chalk.bold(String(n).padStart(4))}`);
      }
      console.log(chalk.dim(`  ${totalMsgs} messages translated · ${totalTools} tool calls`));
    } else {
      console.log(chalk.dim("  none yet — run `strait sync` first"));
    }
  },
});

const history = defineCommand({
  meta: { name: "history", description: "Show past sync conversions" },
  args: {
    limit: { type: "string", description: "max entries to show (default 20)" },
    clear: { type: "boolean", description: "delete the history log" },
  },
  async run({ args }) {
    console.log(BANNER);
    if (args.clear) {
      if (fs.existsSync(HISTORY_PATH)) fs.rmSync(HISTORY_PATH);
      console.log(chalk.dim("history cleared."));
      return;
    }
    const entries = readHistory();
    if (!entries.length) {
      console.log(chalk.yellow("No conversions yet. Run `strait sync` first."));
      return;
    }
    const limit = Number(args.limit) > 0 ? Number(args.limit) : 20;
    const recent = entries.slice(-limit).reverse();
    const resumable: { rt: string; id: string; label: string }[] = [];
    for (const e of recent) {
      const when = e.ts.slice(0, 16).replace("T", " ");
      const fromTint = colorForRuntime(e.from);
      const toTint = colorForRuntime(e.to);
      const arrow = `${fromTint(e.from)} ${chalk.dim("→")} ${toTint(e.to)}`;
      const flag = e.dryRun ? chalk.yellow(" [dry-run]") : "";
      const line =
        `${chalk.dim(when)}  ${arrow}${flag}  ` +
        `${chalk.dim(`${e.messages} msgs, ${e.toolCalls} tools`)}  ` +
        `${fromTint(e.srcId.slice(0, 8))}${chalk.dim("…")} ${chalk.dim("↦")} ${toTint(e.tgtId.slice(0, 8))}${chalk.dim("…")}`;
      console.log(line);
      if (!e.dryRun) resumable.push({ rt: e.to, id: e.tgtId, label: line });
    }
    await pickAndResume(resumable, "Resume one of these conversions?");
  },
});

const main = defineCommand({
  meta: { name: "strait", version: VERSION, description: "Move AI agent sessions between Claude Code and Codex" },
  subCommands: { sync, list, "list-all": listAll, status, search, open, stats, history },
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
      console.log("  strait list-all [--limit 20]");
      console.log("  strait status");
      console.log("  strait search <query> [--limit 20]");
      console.log("  strait open <session-id>");
      console.log("  strait stats");
      console.log("  strait history [--limit 20] [--clear]");
      console.log("");
      console.log(`Run ${chalk.cyan("strait")} in a TTY for interactive mode.`);
      return;
    }
    await runInteractive();
  },
});

function cap(s: string) { return s.charAt(0).toUpperCase() + s.slice(1); }

runMain(main);
