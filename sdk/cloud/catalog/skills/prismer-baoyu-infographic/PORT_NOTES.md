# Port Notes — baoyu-infographic

Ported from [JimLiu/baoyu-skills](https://github.com/JimLiu/baoyu-skills) v1.56.1.

## Changes from upstream

Historical Hermes import modified SKILL.md. The Prismer adaptation additionally repairs layout style IDs and analysis categories; reference files are no longer verbatim.

### SKILL.md adaptations

| Change | Upstream | Hermes |
|--------|----------|--------|
| Metadata namespace | `openclaw` | `hermes` |
| Trigger | `/baoyu-infographic` slash command | Natural language skill matching |
| User config | EXTEND.md file (project/user/XDG paths) | Removed — not part of Hermes infra |
| User prompts | `AskUserQuestion` (batched) | `clarify` tool (one at a time) |
| Image generation | baoyu-imagine (Bun/TypeScript) | `image_generate` tool |
| Platform support | Linux/macOS/Windows/WSL/PowerShell | Linux/macOS only |
| File operations | Bash commands | Hermes file tools (write_file, read_file) |

### What was preserved

- All layout definitions (21 files)
- All style definitions (21 files)
- Core reference files (analysis-framework, base-prompt, structured-content-template)
- Recommended combinations table
- Keyword shortcuts table
- Core principles and workflow structure
- Author, version, homepage attribution

## Syncing with upstream

For updates, select a concrete upstream commit, inspect its diff and merge local repairs. Never overwrite references blindly or execute placeholder URLs. Source: https://github.com/JimLiu/baoyu-skills. The current origin MIT notice (Copyright 2026 Jim Liu) is retained in LICENSE.origin; Hermes snapshot provenance is in PROVENANCE.md.

## Prismer migration record

Recommended legacy style IDs were explicitly remapped: cartoon-hand-drawn -> hand-drawn-edu; isometric-3d/blueprint -> technical-schematic; graphic-novel -> bold-graphic; paper-cutout -> craft-handmade; pop-art -> retro-pop-grid; da-vinci-notebook -> aged-academia. These are selected alternatives, not identical styles or hidden aliases. Keep all 21 actual style files. The source declares MIT; verify the original JimLiu resource revision and preserve its copyright notice before redistribution outside the reviewed bundle. Do not run placeholder update commands.
