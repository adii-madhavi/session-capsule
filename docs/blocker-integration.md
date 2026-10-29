# Session Capsule × Blocker: integration boundary

Reconciled 2026-10-29 against Blocker `main` at `6c66d16` (package `desktop-continuity`) and the
Session Capsule engine in this folder. On this Mac the Blocker baseline passed before any change
(`npm run check`, `check-limits`, `check-takeover`).

## What exists

| Blocker module | Verified responsibility | Decision |
|---|---|---|
| `src/hook.mjs` | Codex plugin hooks append one redacted event per prompt, tool call/result, Stop/Interrupt/SessionEnd | **Reuse as the only recorder.** Session Capsule adds no second recorder. |
| `src/store.mjs` | One JSONL per Codex thread under the plugin data folder; `seq` = line position; `session_ref` = first 12 hex digits of the id | **Reuse for export.** Imports go to a separate `imports/` namespace and never into `sessions/`. |
| `src/checkpoint.mjs` | Bounded checkpoint split into observed / agentNotes / inferred / missing; `pairActions` labels missing results UNKNOWN; `sourceStatus` is a **live, local** check | **Reuse checkpoint semantics and provenance verbatim.** Its artifact list is bounded (mtime scan, ≤30 files), so it is never used as a file inventory. Session Capsule's own enumeration and hashes are used for transfer. |
| `src/redact.mjs` | Best-effort secret redaction | **Reuse at the export boundary** (applied again to the whole handoff object). Session Capsule redacts again when packing. |
| `src/mcp-server.mjs` | Read-only tools over recorded sessions and their project folder | **Add separate read-only tools for imports.** Existing tools are unchanged; no write tool is added. |
| `src/takeover.mjs` | Claude Desktop prompts; `claude://cowork/new` and `claude://claude.ai/new` links (verified on Windows, Claude Desktop 3.6556); clipboard | **Reuse prompt and launch helpers.** An imported continuation gets its own prompt, and only the Claude Desktop routes open a link. |
| `src/watch.mjs`, `src/source.mjs` | Limit detection on local transcripts; ChatGPT process check | **Unchanged.** These checks are meaningless for an imported capsule, because they would inspect the destination computer. |

Session Capsule keeps the parts Blocker doesn't have: the archive format, stable project
snapshots, preview, conflict review, staged apply, backups, the journal, rollback, and the
Claude Code and Codex transcript adapters.

## The boundary: a file contract, not shared code

The two projects exchange one versioned JSON document, the **handoff object**
(`schemas/v1/handoff.schema.json`, kind `session-capsule.handoff`, version `1.0`). Neither project
imports the other's code.

```
MacBook (source)                                   PC (destination, source offline)
Blocker store ──export.mjs──▶ task.handoff.json
                                   │
               capsule pack --handoff task.handoff.json --project <dir>
                                   │
                              task.capsule  ── user's own transfer ──▶  capsule import --dest <dir> [--apply]
                                                                          │ writes <dir>/.session-capsule/<capsule-id>/
                                                                          │   handoff.json  import.json  continuation.md …
                                                                          ▼
                                                    imported-store.mjs register <that folder>
                                                    MCP: list_imports / get_imported_checkpoint / …
```

What the handoff object carries:

- The capsule ID, format version, mode and project fingerprint, filled in at pack.
- Source tool, surface, platform and version, plus the recorder.
- The original session identity (provenance) and, after registration, a separate imported identity.
- The capture time, the last included event `seq` and the counts of included and omitted events.
- The checkpoint sections as Blocker produced them, and the selected recorded events (already
  redacted and truncated at capture).
- Coverage and truncation metadata.
- The user's continuation note.
- The relative file manifest with hashes, copied from the capsule's own enumeration.
- The source status **as observed at capture time**, labelled historical.

Environment requirements, restart notes and the optional file payload stay in the capsule
(`environment.json`, `payload/`), where Session Capsule already handles them.

## Rules carried across the boundary

- **Live vs captured status.** An imported record's `sourceStatus` is labelled historical. The
  live state of the source is reported as `unknown` (there is no remote check), and
  `get_source_status` is never run against an import.
- **Export requires a stopped source.** It is refused when Blocker's own `sourceStatus` says the
  source may still be working. `--force` overrides this and is recorded in the handoff. Pack then
  detects any project change during capture. A checkpoint is not a lock across offline computers.
- **Outcomes stay as evidence supports.** "Result recorded" is copied as-is and is not success.
  UNKNOWN stays UNKNOWN.
- **Paths are provenance only.** Source paths and historical commands are never rewritten. File
  access on the destination goes through the user-chosen folder recorded at registration, and is
  confined to it.
- **Imports are isolated, deduplicated and read-only.** The namespace is `imports/<imported-id>`,
  where the imported ID is derived from the capsule ID. Registering the same capsule again is a
  no-op, and different content under the same capsule ID is refused. Event order and `seq` are
  preserved. New work on the destination is a new session.
- **Transfer and retrieval stay separate.** Archive import, file replacement, deletion and
  rollback happen only through the Session Capsule CLI. The MCP server stays read-only.
