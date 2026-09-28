---
name: prismer-apple-notes
scope: common
description: "Manage Apple Notes via memo CLI: create, search, edit."
version: 1.0.1
author: Hermes Agent
license: MIT
platforms: [ macos ]
metadata:
  nativeReplaces: [ apple-notes ]
  hermes:
    tags: [ Notes, Apple, macOS, note-taking ]
    related_skills: [ obsidian ]
  requiresExplicitGrant: true
prerequisites:
  commands: [ memo ]
---

## Prismer execution contract

This is the uniquely named `prismer-apple-notes` skill, adapted from Hermes.
Use the actual tools exposed by the executing host; examples using terminal,
process, delegate_task, vision_analyze or browser_* are not tool registrations.
Missing dependencies do not hide this skill. Report command startup, version,
account/permissions and task-specific live verification separately. Use task-owned
artifact paths and existing user authorization; do not change shared accounts,
Runtime/provider configuration, global security settings or unrelated work.
See NOTICE.md and LICENSE for resource provenance. Runtime availability and
upstream-entry suppression are owned by the integration layer.


# Apple Notes

Use `memo` to manage Apple Notes directly from the terminal. Notes sync across all Apple devices via iCloud.

## Prerequisites

Run `python3 "$SKILL_ROOT/scripts/readiness.py" notes` using this installed
skill's absolute directory. A PATH hit may be a broken Python launcher; a failed
help/startup check is a dependency failure, not Notes authorization. Record the
installed package version separately. Account sync and Automation require live
acceptance on the executing Mac and are not tested by this helper.

- **macOS** with Notes.app
- Install: `brew tap antoniorodr/memo && brew install antoniorodr/memo/memo`
- Grant Automation access to Notes.app when prompted (System Settings → Privacy → Automation)

## When to Use

- User asks to create, view, or search Apple Notes
- Saving information to Notes.app for cross-device access
- Organizing notes into folders
- Exporting notes to Markdown/HTML

## When NOT to Use

- Obsidian vault management → use the `obsidian` skill
- Bear Notes → separate app (not supported here)
- Quick agent-only notes → use the `memory` tool instead

## Quick Reference

### View Notes

```bash
memo notes                        # List all notes
memo notes -f "Folder Name"       # Filter by folder
memo notes -s "query"             # Search notes (fuzzy)
```

### Create Notes

```bash
memo notes -a                     # Add a note (opens your $EDITOR)
memo notes -a -f "Folder Name"    # Add a note into a specific folder
```

`-a`/`--add` is a bare flag — it opens your `$EDITOR` to compose the note; it does
not take a title argument. Use `-f/--folder` to target a folder. Set `$EDITOR`
first (e.g. `export EDITOR=vim`).

### Edit Notes

```bash
memo notes -e                     # Interactive selection to edit
```

### Delete Notes

```bash
memo notes -d                     # Interactive selection to delete
```

### Move Notes

```bash
memo notes -m                     # Move note to folder (interactive)
```

### Export Notes

```bash
memo notes -ex                    # Export to HTML/Markdown
```

## Limitations

- Cannot edit notes containing images or attachments
- Interactive prompts require terminal access (use pty=true if needed)
- macOS only — requires Apple Notes.app

## Rules

1. Prefer Apple Notes when user wants cross-device sync (iPhone/iPad/Mac)
2. Use the `memory` tool for agent-internal notes that don't need to sync
3. Use the `obsidian` skill for Markdown-native knowledge management
4. Select the exact authorized note/folder before editing, deleting or moving;
   read back the result. Do not overwrite attachment-bearing notes.
