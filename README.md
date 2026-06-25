# strait

> Move your AI agent sessions between Claude Code, Codex, and OpenCode.

Hit a Claude rate limit mid-task? Want to swap to Codex without losing context? `strait` translates sessions between Claude Code, Codex, and OpenCode — with full history preserved — and gives you one CLI to search, resume, and track every conversation across all three.

**Status:** alpha. All three runtimes (Claude Code, Codex, OpenCode) are bidirectional and resume-verified end-to-end.

```
strait — session portability for AI agents
? What do you want to do? Sync Claude → Codex
? Pick a claude session: 5f1e23a6  2026-04-28 (103 msgs)  # the build plan
? Where should the translated session be written? Real
✔ Translated 103 messages ↦ 44 tool calls
  ⚠ dropped 10 thinking blocks (no Codex equivalent)
 Claude ~~~~~~~~~~~⛵~~~~~~~~~~~ Codex
✓ Done. Resume command: codex resume f2fca69c-…
? What now? Run "codex resume f2fca69c-…" now (in /Users/me/proj)
```

Or skip the menu and pass flags directly: `strait sync claude codex --latest --dry-run`.

## Install

```bash
npm install -g strait-cli
strait                            # interactive menu
strait sync claude codex --latest # or use flags
```

(The CLI command is `strait` even though the package is `strait-cli` — the bare name was already taken on npm.)

### From source

```bash
git clone https://github.com/Sasitilak/strait.git && cd strait
npm install
npm run dev
```

### From a GitHub tarball (latest main)

```bash
npm install -g https://github.com/Sasitilak/strait/archive/refs/heads/main.tar.gz
```

Requires Node 18+. Pure JavaScript / WASM only — no native compilation needed.

## Usage

```bash
# pick a session interactively (recommended)
strait

# or specify everything via flags
strait sync claude   codex   --latest [--dry-run] [--verbose]
strait sync codex    claude  --latest
strait sync opencode claude  --latest
strait sync opencode codex   --latest

strait sync <from> <to> --session <id>     # specific session

strait list claude     # 10 most recent, color-coded UUIDs
strait list codex
strait list opencode
```

`--dry-run` writes to `./tmp/` instead of the real target dir so you can inspect output before committing it. `--verbose` logs each message as it's translated.

After a sync, strait can launch the resume command for you (in the original session's cwd) — pick "Run resume now" in interactive mode.

### Discovery & history

```bash
strait status                  # what's installed, session counts, disk usage
strait list-all                # sessions from every runtime, merged, newest first
strait search "auth bug"       # grep the first user message of every session
strait open <id>               # find a session by id prefix and launch resume
strait stats                   # per-runtime counts + per-direction conversions
strait history                 # past syncs (logged to ~/.strait/history.jsonl)
```

`search`, `list-all`, and `history` end with an interactive picker — pick an entry and strait spawns the right runtime (`claude --resume` / `codex resume` / `opencode --session`) for you.

### Insights & analytics

`strait insights` aggregates your usage across every runtime — tools, MCP servers, skills, models, token usage, and when you actually work — entirely **offline**. Nothing leaves your machine.

```bash
strait insights                       # full local report
strait insights --runtime claude      # one runtime (repeatable)
strait insights --since 2026-01-01    # only sessions on/after a date
strait insights --days 30 --top 15    # widen the activity window / tables
strait insights --json                # raw MetadataSnapshot (machine-readable)
```

What you get: top tools, MCP servers (parsed from `mcp__<server>__<tool>`), installed skills, models, **token usage** (fresh input+output shown separately from cache reuse), a day-by-day activity chart, and a local time-of-day "when you work" histogram.

`--json` emits a metadata-only snapshot — tool/MCP/skill/model **names**, counts, dates, token totals, and time-of-day histograms. It **never** contains message text, code, file contents, tool arguments, or file paths. Everything runs locally; nothing is uploaded anywhere.

## Supported runtimes

| Runtime       | Read | Write | Resume verified |
|---------------|:----:|:-----:|:---------------:|
| Claude Code   |  ✓   |   ✓   |       ✓         |
| Codex         |  ✓   |   ✓   |       ✓         |
| OpenCode      |  ✓   |   ✓   |       ✓         |

All six directions work:

```
claude   ↔  codex
claude   ↔  opencode
codex    ↔  opencode
```

## What works

- Text user messages, assistant text replies
- Tool calls + tool results (any tool name — passed through verbatim)
- Multi-block assistant messages (text + tool_use + text + tool_use, in order)
- `tool_result` content as either string or array of text parts
- Streaming line-by-line read (Claude/Codex) and indexed SQLite read/write (OpenCode)
- Atomic write to OpenCode's SQLite DB with WAL checkpoint, integrity check, and sidecar cleanup — probes the SQLite write lock to refuse a write only when OpenCode is actually holding it (no false positives from Spotlight or Finder)
- Auto-cd into the imported session's original cwd when launching resume
- Auto-launch with the right resume flag per runtime (`codex resume <id>`, `claude --resume <id>`, `opencode --session <id>`)
- Filters out Codex's `<environment_context>` synthetic user turns

## Contributing

Issues and PRs welcome — this is alpha. The most valuable bug reports are real Claude sessions that fail to resume in Codex.

## License

MIT.
