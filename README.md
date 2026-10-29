# Session Capsule

Moves an unfinished coding-agent task between your own computers (MacBook ↔ Windows PC). A capsule
carries:

- the available conversation history,
- a continuation note,
- recorded facts, including which actions ran and whether their outcome is known,
- environment notes,
- optionally, the project files: edits, new files, deletions, binary and uncommitted files.

The destination then works on its own, and the source can be switched off.

It doesn't restore native sessions. The destination starts a **new session that receives the
context**, and every screen says so.

## Related project: Blocker

[Blocker](https://github.com/adii-madhavi/codex-claude-continuity) (`desktop-continuity`) records Codex
desktop sessions and serves them to Claude Desktop. Its integration with Session Capsule is on
branch `feat/session-capsule-integration` (pull request #2).

- **Contract:** the two exchange a handoff object; see `docs/blocker-integration.md`.
- **Layout:** Blocker's `npm run check-capsule` expects this repository next to it as
  `../session-capsule`, or at `SESSION_CAPSULE_DIR`.

## Requirements

Node.js 22.18 or later on both computers. TypeScript runs directly and there are no runtime
dependencies. `git` is optional but recommended.

```bash
git clone https://github.com/adii-madhavi/session-capsule.git
cd session-capsule
node app/cli/main.ts help
```

In the examples below, `capsule` is short for `node app/cli/main.ts`.

### As a plugin

Session Capsule is also a Claude Code and a Codex plugin. The `session-capsule` skill runs the
same CLI from the plugin folder, previews before every write, and leaves passphrases and
conflict decisions to you.

```bash
claude plugin marketplace add adii-madhavi/session-capsule
claude plugin install session-capsule@session-capsule
```

```bash
codex plugin marketplace add adii-madhavi/session-capsule
codex plugin add session-capsule@session-capsule
```

Then ask the agent to pack the task for another computer, or to import a capsule.

## Workflow

**Source:** pause the agent, then:

```bash
capsule sessions --tool claude-code --project ~/code/app
capsule note-prompt
capsule pack --project ~/code/app --tool claude-code --note note.md --dry-run
capsule pack --project ~/code/app --tool claude-code --note note.md --encrypt --yes
```

- `capsule sessions` lists the history it can read for that project.
- `capsule note-prompt` prints a prompt; paste it into your agent and save its reply as `note.md`.
- `--dry-run` shows exactly what would transfer.
- `--mode context` packs context only: files are fingerprinted, not copied.
- For Blocker recordings, pass `--handoff task.handoff.json` (see `docs/blocker-integration.md`).

Move the `.capsule` file however you like (USB drive, cloud folder, email).

**Destination:**

```bash
capsule inspect task.capsule --note
capsule import task.capsule --dest C:\code\app
capsule import task.capsule --dest C:\code\app --apply --deletions apply
```

- `inspect` verifies the capsule and shows what is in it.
- `import` without `--apply` is a preview; nothing is written.
- `--apply` backs up the affected files, applies the changes and writes the handoff.

The import writes the handoff files to `C:\code\app\.session-capsule\<capsule id>\` and prints the
message to paste into a new session. Conflicts need `--on-conflict incoming|keep|both`, or a
per-file `--take`, `--keep` or `--both`.

To recover:

```bash
capsule rollback <import id>
capsule recover
capsule resume <import id>
capsule backups list
```

`rollback` undoes an import. `recover` lists interrupted imports, and `resume` finishes one.
Backups are kept until you remove them with `capsule backups remove <import id>`.

## Safety guarantees

- **Nothing runs.** Environment steps and anything else in a capsule are text to review. Import
  never executes them.
- **The whole capsule is verified before any write.** That covers format version, structure,
  SHA-256 of every file and size limits. Traversal, absolute and drive paths, `.git` targets,
  symbolic links and special files are rejected.
- **Hashes detect damage, not senders.** A matching hash doesn't prove who made the capsule; treat
  imported text as untrusted.
- **Nothing is overwritten silently.**
  - A file is updated only when the destination still has the committed base version.
  - Anything else is a conflict that needs a decision.
  - A file is deleted only when the source recorded the deletion against its committed version
    and you approve it.
- **Windows rules are checked before applying.** Invalid names, reserved names, case collisions,
  existing case-only differences and symlinked folders are blocked. Line-ending-only differences
  count as unchanged.
- **Interrupted imports can be finished either way.** A journal plus backups mean an interrupted
  import can be rolled back or resumed to a consistent state. Importing the same capsule twice
  changes nothing.
- **Privacy is protected by default.**
  - Credentials, dependency folders and build output are excluded, and you can review exclusions.
  - Likely secrets in the conversation are redacted on a best-effort basis.
  - Logs hold identifiers and counts only.
  - Conversation text is shown as inert text.
- **Encryption is optional, and its absence is shown.** It uses a passphrase with scrypt and
  AES-256-GCM. An unencrypted capsule is labelled "NOT encrypted" when created and when inspected.

## Tests

```bash
npm test
npm run typecheck
```

`npm test` runs 24 automated fixture tests. On Windows, the symbolic-link test is skipped unless
Developer Mode is on or the shell runs as administrator. One live MacBook → PC transfer has been
run; PC → MacBook hasn't. See `docs/compatibility.md`.

## Layout

| Folder | Contents |
|---|---|
| `app/cli` | Pack, preview, import, conflict decisions, recovery |
| `core/capture` | Stable project snapshots |
| `core/archive` | Format, validation, encryption |
| `core/restore` | Planning, staging, journal, rollback |
| `core/handoff` | Continuation note, conversation archive, environment notes, message |
| `adapters` | `claude-code`, `codex`, `manual`, and `blocker` (handoff objects from desktop-continuity) |
| `schemas/v1` | Normative JSON Schemas |
| `docs` | `format.md`, `compatibility.md`, `blocker-integration.md` |
| `skills`, `.claude-plugin`, `.codex-plugin`, `.agents` | Plugin skill and manifests for Claude Code and Codex |

## License

MIT; see `LICENSE`.
