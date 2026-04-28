# Format mapping (Phase 0 — observed from real sessions)

Sources:
- Claude: `~/.claude/projects/-Users-ravi-tilak-Documents-strait/5f1e23a6-….jsonl`
- Codex (no tools): `~/.codex/sessions/2026/04/27/rollout-…-019dcf4b-….jsonl`
- Codex (with tools): `~/.codex/sessions/2026/03/13/rollout-…-019ce403-….jsonl`

## Claude line shape

```
{
  type: "user" | "assistant" | "summary" | "permission-mode" | "attachment" | "file-history-snapshot" | "last-prompt",
  uuid, parentUuid, timestamp, sessionId, version, cwd, gitBranch,
  message: {                          // only when type ∈ {user, assistant}
    role,
    content: string | ContentBlock[]  // user can be string; assistant is always array
  }
}
```

`ContentBlock` variants:
- `{type: "text", text}`
- `{type: "thinking", thinking, signature}`            (note: field is `thinking`, not `text`)
- `{type: "tool_use", id, name, input}`
- `{type: "tool_result", tool_use_id, content, is_error?}`  (content can be string OR array of `{type:"text",text}` blocks)
- `{type: "image", source: {...}}`

Non-message lines (skip): `permission-mode`, `attachment`, `file-history-snapshot`, `last-prompt`, `summary`.

## Codex line shape (the resume-relevant slice)

Each line: `{timestamp, type, payload}`.

`type` ∈:
- `session_meta` — once at top. Payload has `id, timestamp, cwd, originator, cli_version, model_provider, base_instructions{text}`.
- `turn_context` — payload `{turn_id, cwd, model, approval_policy, sandbox_policy, …}`.
- `response_item` — **the actual conversation history**. Payload variants:
  - `{type:"message", role:"developer"|"user"|"assistant", content:[{type:"input_text"|"output_text", text}]}`
  - `{type:"reasoning", summary:[], content, encrypted_content}`
  - `{type:"function_call", name, arguments:"<JSON-stringified>", call_id}`
  - `{type:"function_call_output", call_id, output:"<string>"}`
  - `{type:"custom_tool_call"} / {type:"custom_tool_call_output"}` (MCP — out of scope v1)
  - `{type:"web_search_call"}` (skip v1)
- `event_msg` — UI replay events (`user_message`, `agent_message`, `task_started/complete`, `token_count`, `reasoning`, `error`, `thread_name_updated`). Cosmetic. **Skip on emit; resume reconstructs from response_items.**

## The mapping (Claude → Codex)

| Claude block                         | Codex emission                                                                 |
|--------------------------------------|---------------------------------------------------------------------------------|
| user msg, string `content`           | `response_item` / `message` role=user, `content:[{type:"input_text",text}]`     |
| user msg, `text` block               | same                                                                            |
| user msg, `tool_result` block        | `response_item` / `function_call_output` `{call_id, output:<stringified>}`      |
| assistant `text` block               | `response_item` / `message` role=assistant, `content:[{type:"output_text",text}]` |
| assistant `tool_use` block           | `response_item` / `function_call` `{name, arguments: JSON.stringify(input), call_id: id}` |
| assistant `thinking` block           | DROP in v1 (cannot reconstruct encrypted reasoning)                             |
| `image` block                        | DROP in v1 with warning                                                         |

Always preserve **order**. Multi-block assistant message → multiple `response_item` lines, in order.

## Things still uncertain (call out in code)

1. Tool name fidelity: Claude tool `Bash` → Codex registered name is `exec_command`/`shell`. Resume will display the call but won't re-execute unless names match the user's Codex tool registry. v1: keep the Claude name verbatim, document.
2. `tool_result.content` array form: concatenate text fields with `\n`.
3. Whether Codex requires a `session_meta` line for resume to work, or whether `turn_context` alone suffices. v1: emit both, mirroring real rollouts.
4. `call_id` format: real Codex uses `call_<24hex>`, Claude uses `toolu_<24>`. Pass through Claude id verbatim; if resume rejects, generate `call_<hex>` and remap.
