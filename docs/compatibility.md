# Integration findings and compatibility

Recorded 2026-10-29 on macOS 26 (Darwin 25.5, arm64) by reading the local session stores of
both desktop apps. These are observations of record layouts, not vendor-documented contracts:
both tools can change their formats in any release, so each adapter reads defensively and the
manual adapter stays available as a fallback.

First-release target surface: **desktop apps** (the Claude desktop app's Code tab and Codex
Desktop). Both share their history stores with the matching CLI, so the CLIs work as well.

## Summary

| Capability | Claude Code (desktop Code tab) | Codex Desktop | Manual |
|---|---|---|---|
| Tool version observed | 2.1.309 (`version` field) | 0.163.0-alpha.10.2 (`cli_version`) | n/a |
| History access | Verified: local JSONL | Verified: local JSONL, usually zstd-compressed | User-supplied transcript |
| Session listing per project | Verified (`cwd` on records) | Verified (`session_meta.cwd`) | n/a |
| Session titles | `custom-title` records | `session_index.jsonl` (`thread_name`) | n/a |
| Completeness | As recorded in the file | Possibly partial (see below) | User-supplied |
| Native session restore | **Not supported** | **Not supported** | n/a |
| Launch on destination | Manual: open folder, paste handoff message | Manual: open folder, paste handoff message | Same |

"Not supported" means no mechanism has been verified and tested. Per the plan, native restore
stays disabled until one is. Every import says plainly that the destination gets **a new
session receiving context**, not a restored one.

## By surface (capture and continuation tracked separately)

| Surface | History into a capsule | Continue on the destination | Evidence |
|---|---|---|---|
| Codex desktop | Session Capsule `codex` adapter, or a Blocker handoff from its hooks | Manual paste | Adapter read real Codex Desktop 0.163 and 0.165 sessions on macOS, and a 0.165 session on Windows 11 (counts only). Blocker hooks verified on Windows. |
| Codex CLI | Same `codex` adapter (same store) | Manual paste | **Not verified**: no CLI session was available to read. |
| Claude Desktop Chat / Cowork | No history capture | Blocker `continue.mjs --to cowork\|chat` (prefilled `claude://` link) and read-only MCP import tools | Links verified on Windows with Claude Desktop 3.6556 for same-computer takeover; the cowork route dry-ran for an imported capsule on Windows 11; not yet on macOS. |
| Claude Code (desktop Code tab, CLI) | `claude-code` adapter | Manual paste | Adapter read a real desktop-tab session (Claude Code 2.1.309): 276 messages. CLI sessions use the same store, not separately verified. |

One live MacBook → PC transfer has been run (2026-10-29: macOS arm64 to Windows 11, Node 24.19).
The PC read the context and continued the task; PC → MacBook hasn't been run. Automated checks
simulate both computers on one machine and delete the source data before import. On Windows they
pass, except that the symbolic-link test is skipped without Developer Mode or an administrator
shell.

## Claude Code

- **Location:** `~/.claude/projects/<slug>/<session-id>.jsonl`, or under `$CLAUDE_CONFIG_DIR` when set.
  `<slug>` is the project path with every non-alphanumeric character replaced by `-`
  (`/Users/me/My App` → `-Users-me-My-App`). The adapter checks the slug folder first, then
  falls back to reading the `cwd` of every session, because the slug rule isn't guaranteed.
- **Surface:** the `entrypoint` field says where the session ran: `claude-desktop` (desktop
  app), `cli`, or an IDE value.
- **Record types used:** `user` (text, or `tool_result` blocks) and `assistant` (`text`,
  `tool_use`, `thinking`), plus `custom-title`, and `system` with subtype `compact_boundary`.
- **Omitted on purpose:**
  - `thinking` blocks.
  - Sidechain (sub-agent) records (`isSidechain: true`).
  - Meta records.
  - Harness-injected `<system-reminder>` blocks.
  - Internal bookkeeping records (`api-request*`, `file-history-*`, `queue-operation`, …).

  Each omission is counted in the capsule's conversation notes.
- **Actions extracted for the continuation note:**
  - `Bash` → command.
  - `Edit`/`Write`/`MultiEdit`/`NotebookEdit` → file edit.
  - `mcp__*` → external tool call, which may have side effects outside the project.

## Codex

- **Location:** `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl[.zst]`, or under `$CODEX_HOME` when set.
  Desktop sessions are zstd-compressed, which Node handles through `zlib.zstdDecompressSync`
  (Node ≥ 22.15). Titles come from `~/.codex/session_index.jsonl` (`id`, `thread_name`, `updated_at`).
- **Surface:** `session_meta.payload.originator` says where the session ran (`Codex Desktop`).
  `source` isn't reliable for this: desktop sessions record `vscode`.
- **Sub-agents:** rollouts whose `source` is `{ "subagent": … }`, such as guardian reviews, are
  separate files. They aren't listed as sessions.
- **Record types used:** `response_item` of these payload types:
  - `message`, with role `user` or `assistant`
  - `function_call`, `custom_tool_call` and `local_shell_call`
  - the matching `*_output` items
  - `compacted`
- **Omitted on purpose:**
  - `developer` messages (system instructions).
  - `reasoning` items.
  - Injected context blocks in user messages, such as `<environment_context>`, `<skill>`,
    AGENTS.md instructions and app-state blocks.
  - `event_msg` telemetry.
- **Completeness caveat:** observed sessions declare `history_mode: "paginated"`, and Codex also
  keeps SQLite stores (`thread_history_1.sqlite`, `state_5.sqlite`). These weren't read: their
  schema is undocumented and could change. Paginated sessions are therefore marked **possibly
  partial**, and the preview shows exactly what was captured.

## Native restoration: why it's off

- **Claude Code:** the desktop app keeps its own session metadata, and the JSONL location
  depends on the absolute project path, which differs between macOS and Windows. Copying a
  JSONL file across machines hasn't been tested end to end.
- **Codex:** threads are spread across rollout files and SQLite state, and a thread-import
  record (`external_agent_session_imports.json`) exists but its contract is unknown.

Turning either on requires an adapter capability that has been tested on both platforms.

## Desktop launch

No supported deep link or command line for "open this folder with this prompt" was verified
for either desktop app. Import therefore:

1. writes the handoff files into `<project>/.session-capsule/<capsule-id>/`, and
2. prints a ready-to-copy continuation message (`capsule handoff … --copy` puts it on the clipboard).

The user opens the project in their coding tool and pastes the message.

## Environment requirements

- Node.js ≥ 22.18 on both computers. Older versions can't run the TypeScript directly or read
  zstd. On Windows, install Node from nodejs.org or with `winget install OpenJS.NodeJS.LTS`.
- `git` is optional. When present, Session Capsule records branch, commit and per-file status,
  and uses the last commit as the common base for safe updates.
