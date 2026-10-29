# Capsule format 1.x

A capsule is a ZIP archive (`.capsule`). When it's encrypted, the whole ZIP is wrapped in the
envelope described below. Readers accept format major version 1 and reject anything else with an
"unsupported version" error.

```
session-capsule/
  manifest.json       format, versions, tool, project, conversation summary, integrity hashes
  handoff.json        portable handoff object (shared with Blocker; schemas/v1/handoff.schema.json)
  continuation.md     note sections + facts recorded by Session Capsule (+ recorder checkpoint)
  conversation.json   available history, one entry per message, with source attribution
  conversation.md     the same, rendered as inert Markdown (optional)
  environment.json    tool versions, detected runtimes, suggested steps (never executed)
  files.json          relative paths, SHA-256, base versions, deletions, exclusions, platform issues
  payload/<path>      file contents (full capsules only)
```

The normative schemas are in `schemas/v1/`.

## Integrity

`manifest.integrity` lists the SHA-256 and size of every metadata file. `files.json` lists the
SHA-256 of every payload file. A reader checks all of these before using anything. They detect
corruption, not who made the capsule.

## Paths

- Paths are relative, use `/` separators and are Unicode NFC.
- There are no `.` or `..` segments, no leading `/`, no drive letters and no backslashes.
- Nothing may target `.git` or `.session-capsule`.
- Symbolic links and special files are never stored.

## Limits

- At most 65,000 entries and 4 GiB per capsule (no ZIP64).
- By default, 1 GiB per expanded file and 4 GiB expanded in total.
- Declared sizes are enforced while inflating.

## Encryption envelope

The envelope is laid out as follows:

1. The magic bytes `SCAPENC1`.
2. A big-endian `u32` header length.
3. The header JSON: `v`, `kdf` = `scrypt`, `N`, `r`, `p`, `salt` and `noncePrefix`, both base64,
   and `chunkSize`.
4. The chunks.

Each chunk is a `u32` ciphertext length, then the AES-256-GCM ciphertext, then a 16-byte tag.

- The nonce is `noncePrefix` (7 bytes), then the chunk index (`u32`), then a final-chunk flag
  (1 byte).
- The header is the associated data for every chunk.
- Readers bound the scrypt cost and the chunk size before deriving a key.

## Updates and deletions

- `baseSha256` is the committed (git HEAD) version of a file. An import updates a destination file
  only when it still matches that base. The comparison also accepts a match after CRLF → LF
  normalization (`normSha256` / `baseNormSha256`).
- A deletion is recorded only for a tracked file removed from the working tree, together with its
  committed hash. Import never infers a deletion from a missing file.
