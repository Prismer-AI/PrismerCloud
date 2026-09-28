---
name: prismer-obsidian
scope: common
category: note-taking
description: Read, search, create, and edit notes in the Obsidian vault.
version: 1.0.0
author: Teknium (teknium1), Hermes Agent
license: MIT
platforms: [ linux, macos, windows ]
metadata:
  nativeReplaces: [ obsidian ]
  hermes:
    tags: [ Obsidian, Notes, Markdown, Vault ]
    related_skills: []
  requiresExplicitGrant: true
---

# Obsidian Vault

Use this skill for filesystem-first Obsidian vault work: reading notes, listing notes, searching note files, creating notes, appending content, and adding wikilinks.

## Vault path

Use a known or resolved vault path before calling file tools.

Require an explicitly configured OBSIDIAN_VAULT_PATH or a vault path supplied by the user. If absent, report missing configuration; do not create or write to a fallback vault.

File tools do not expand shell variables. Do not pass paths containing `$OBSIDIAN_VAULT_PATH` to `read_file`, `write_file`, `patch`, or `search_files`; resolve the vault path first and pass a concrete absolute path. Vault paths may contain spaces, which is another reason to prefer file tools over shell commands.

If the vault path is unknown, `terminal` is acceptable for resolving `OBSIDIAN_VAULT_PATH` or validating the user-supplied path. Once the path is known, switch back to file tools.

## Read a note

Use `read_file` with the resolved absolute path to the note. Prefer this over `cat` because it provides line numbers and pagination.

## List notes

Use `search_files` with `target: "files"` and the resolved vault path. Prefer this over `find` or `ls`.

- To list all markdown notes, use `pattern: "*.md"` under the vault path.
- To list a subfolder, search under that subfolder's absolute path.

## Search

Use `search_files` for both filename and content searches. Prefer this over `grep`, `find`, or `ls`.

- For filenames, use `search_files` with `target: "files"` and a filename `pattern`.
- For note contents, use `search_files` with `target: "content"`, the content regex as `pattern`, and `file_glob: "*.md"` when you want to restrict matches to markdown notes.

## Create a note

Use scripts/write_note.py with an explicitly authorized vault, relative Markdown path, expected revision and content on stdin. This applies the path, lock, revision and atomic-write checks; do not bypass them with direct writes.

## Append to a note

Prefer a native file-tool workflow when it is not awkward:

- Read the target note with `read_file`.
- Use `patch` for an anchored append when there is stable context, such as adding a section after an existing heading or appending before a known trailing block.
- For a whole-note rewrite, retain the read hash and use the same guarded write helper; do not silently overwrite a changed note.

For an anchored append with `patch`, replace the anchor with the anchor plus the new content.

For a simple append with no stable context, `terminal` is acceptable if it is the clearest safe option.

## Targeted edits

Use `patch` for focused note changes when the current content gives you stable context. Prefer this over shell text rewriting.

## Wikilinks

Obsidian links notes with `[[Note Name]]` syntax. When creating notes, use these to link related content.

## File ownership and concurrent editing

Resolve the vault and target real paths, including every existing symlink, and require the target to remain inside the authorized vault. Do not follow links into other mounts/tenants. Read the current file and retain its hash before editing; recheck immediately before an atomic same-directory replacement and fail on concurrent modification. Prefer the bundled guarded helper for writes. Preserve frontmatter, wikilinks, backlinks and encoding. Obsidian GUI or an API key is not required for local Markdown; this is not a replacement for Prismer memory.

### Guarded write command

From this skill directory: `python3 scripts/write_note.py --vault /absolute/authorized/vault --path folder/note.md --expected-sha256 <hash-or-missing>`, with proposed UTF-8 Markdown on stdin. Parent folders must already exist. The helper uses POSIX no-follow directory handles, cooperative locking, a pre-replace revision check and atomic replacement; on Windows use a host-native equivalent with the same checks rather than bypassing them. Pause/synchronize non-cooperating external editors before replacement: no file-based hash check can guarantee CAS against an editor that ignores the lock.
