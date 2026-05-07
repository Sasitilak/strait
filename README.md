# strait

> Move your AI agent sessions between Claude Code, Codex, and OpenCode.

Hit a Claude rate limit mid-task? Want to swap to Codex without losing context? Stuck in OpenCode and want your history elsewhere? `strait` translates sessions between agents, one shot, with full conversation history preserved.

**Status:** alpha. All three runtimes (Claude Code, Codex, OpenCode) are bidirectional and resume-verified end-to-end.

```
strait v0.0.1 — session portability for AI agents
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
- Atomic write to OpenCode's SQLite DB with WAL checkpoint, integrity check, and sidecar cleanup — refuses to write if OpenCode is running
- Auto-cd into the imported session's original cwd when launching resume
- Auto-launch with the right resume flag per runtime (`codex resume <id>`, `claude --resume <id>`, `opencode --session <id>`)
- Filters out Codex's `<environment_context>` synthetic user turns

## Known limitations

- **Thinking blocks are dropped.** Both Claude and Codex store reasoning in formats the other can't reconstruct (Codex uses encrypted blobs, Claude requires a valid signature). Tool calls and final outputs are preserved; the model just doesn't see its own prior chain-of-thought.
- **Tool names pass through verbatim.** Resume will display the original tool calls (e.g. `Bash`), but the receiving runtime won't re-execute them unless that name is also one of its registered tools. The transcript is intact; new turns use the receiving runtime's own tools.
- **Codex resume logs a non-fatal "thread not found" warning** on imported sessions. This is a Codex-internal cache issue for rollouts it didn't create itself — the conversation context still loads correctly and new turns persist.
- **Cloud-only agents are not supported** — Antigravity, Cursor cloud agents, ChatGPT, Devin, Replit Agent, etc. don't store sessions on disk, so there's nothing for `strait` to read.
- **Format is unstable.** Schemas change between releases. v1 targets Claude 2.1.x, Codex 0.114–0.125, OpenCode current.
- **No tests yet.** Verified by running against real sessions.

## Contributing

Issues and PRs welcome — this is alpha. The most valuable bug reports are real Claude sessions that fail to resume in Codex.

## License

MIT.
