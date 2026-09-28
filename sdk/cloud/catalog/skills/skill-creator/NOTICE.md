# Resource License Boundaries

- Imported Anthropic authoring/evaluation resources retain Apache-2.0 in
  `LICENSE.txt`, including its original copyright notice. Local fixes do not
  replace that license.
- Prismer-specific workflow, `scripts/import-library.mjs`, and legacy
  `references/skill-authoring/` / `references/skill-builder/` retain MIT from
  `sdk/cloud/LICENSE`, reproduced as `LICENSE.prismer` (Copyright 2026 Prismer).
- `references/hermes-agent-skill-authoring/GUIDE.md` contains the full upstream
  `skills/software-development/hermes-agent-skill-authoring/SKILL.md` at Hermes
  revision `1a1f4a59e252e1dc0137e7b2e7bcc8b0381d19c4`, adapted for scope/path
  safety and explicit authorization of git operations. Its MIT license,
  Copyright 2025 Nous Research, is retained beside the guide as `LICENSE`.
  The upstream skill has no additional resource files. No source upstream was
  modified. Its skill identity is recorded in `metadata.nativeReplaces`.

Distribute these notices and nested license files with the corresponding
resources. The mixed-license frontmatter is not a relicensing of any source.
