---
name: skill-builder
scope: common
description: Low-level helper for the DIRECT-PUBLISH tier of skill authoring — it is NOT the entry point for creating skills. To make/build/author/package a skill, use `skill-creator` (the single canonical skill author). This page only documents `skill-creator`'s direct-publish tier (`cloud skill create --install`, or the portable `scripts/ingest.mjs` ingest fallback) and the SS-01 bundle/ingest format. Do NOT route here when the user wants to create a skill — route to skill-creator.
license: MIT
compatibility:
  - prismer-sdk
  - hermes
  - claude-code
  - codex
metadata:
  category: authoring
allowed-tools:
  - Read
  - Write
  - Bash
  - WebFetch
---

# Skill Builder — the direct-publish tier of `skill-creator`

> **Not an authoring entry point.** Creating, editing, or packaging a skill is
> the job of **`skill-creator`** — the single canonical skill author. This page
> only exists to document one of skill-creator's two publish trust tiers
> (**direct publish**) plus the low-level `scripts/ingest.mjs` ingest helper.
> If the user says "turn this into a skill" / "make a skill" / "package this
> workflow", **use `skill-creator`**, not this.

## Where this fits

`skill-creator` drives the full lifecycle author→validate→test→package→publish.
At the publish step there are two trust tiers ([[16-skill-role-authoring-as-agent-capability]] §5.3):

- **Direct create (default)** — `cloud skill create ./<dir> [--install]` →
  `status=active`, `publishScope=workspace` (**private**, installable — NOT public).
  Marketplace publish is the separate `cloud skill publish`. This page.
- **Draft-gated (explicit)** — `cloud skill draft create` → `status=draft`,
  Studio Authoring promotes it. Documented under `skill-authoring`.

Both tiers are reached from inside `skill-creator`. Neither is a separate
"author a skill" skill — they're publish-verb choices.

## SS-01 bundle format (reference)

The canonical contract is **SS-01** (`public/docs/Standardization/01-skill-standard.md`).
A skill is a directory named exactly `<slug>/`:

```
<slug>/
├── SKILL.md        # required — frontmatter + body (injected into agent prompt)
├── scripts/        # optional — runnable code
├── references/     # optional — docs loaded as needed
└── assets/         # optional — templates / images
```

`SKILL.md` frontmatter (SS-01 §3.2 — aligns with agentskills.io):

```markdown
---
name: <slug>                 # must equal the dir name
scope: common                # common | persistence | coding
description: <one line; what it does AND when to trigger>
license: MIT
compatibility:
  - prismer-sdk
  - claude-code
metadata:
  category: <category>
---

# <Title>
<body: imperative instructions, progressive disclosure, ≤500 lines>
```

`scope` buckets the skill for per-role native-skill filtering (release203/13):
`common` (default, any agent) / `persistence` (memory/state) / `coding`
(code-agent targets). It lives inside SKILL.md and round-trips automatically.

## Direct-publish ingest

The preferred path is the `cloud skill create` CLI (driven from `skill-creator`):

```bash
cloud skill create ./<slug> --install --json
# POST /api/im/skills (+ install). Reads api key from prismer config.
```

The legacy script entrypoint is retained as a Cloud CLI adapter. It requires
`cloud` on PATH (or `PRISMER_CLOUD_BIN` pointing to the current build):

```bash
# Credentials come from the injected environment, never literal command text.
node references/skill-builder/scripts/ingest.mjs ./<slug> --install
```

The adapter delegates frontmatter parsing, complete resource/NOTICE inclusion,
manifest hashing and install error handling to `cloud skill create`. It does
not perform raw HTTP fallback or implement a separate YAML parser.

If `cloud` is present but `skill create` is missing, that is CLI version skew,
not permission to bypass the lifecycle. Report `cloud --version` and use the
current repository build. The script fallback is not a workaround for a
partially stale CLI because its auth/scope/readback behavior is precisely what
the authoring flow needs to verify.

The bundle reader accepts YAML literal/folded block scalars in frontmatter, so
upstream `description: |` / `description: >` content must not be rewritten to a
single line merely for ingest. The 50-unit description quality floor counts
non-ASCII code points as two units, avoiding meaningless padding of concise CJK
descriptions while retaining the English quality bar.

> **The catalog slug is server-assigned**, not your frontmatter `name`. Community
> creates are prefixed (`weather-lookup` → `community-weather-lookup`). Use the
> slug returned in the 201 response for install, `cloud skill show`, and a role's
> `requiredSkills`. A `409` means the slug already exists — pick a new name;
> there is no in-place overwrite.

## After publishing: managing a live skill

Publishing is not a one-way door. Every verb below is a `cloud skill` subcommand
(the `prismer skill` daemon CLI has the identical set).

**The one fact everything else follows from: an installed skill is a LIVE
REFERENCE, not a snapshot.** `im_agent_skills` stores only `skillId` +
`installedRevision`; every daemon sync re-reads the catalog row's current
`contentManifest`. So **editing a published skill's content propagates to every
agent that has it installed** — no re-install, no opt-in. That is why the server
rejects a content edit with `422 changelog_required` unless you pass
`--changelog "<what changed>"`: consumers are entitled to know what changed under
them. Metadata-only edits (description / icon / tags) need no changelog.

| Verb                                        | What it does                                                                            | Effect on people already using it                                        |
| ------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `cloud skill delist <slug> [--reason ...]`  | Removes it from Marketplace search. Content, installs, syncs all keep working.          | **None.** They keep the skill and keep receiving content updates.        |
| `cloud skill relist <slug>`                 | Puts it back (re-runs the publish gate, so an admin takedown still blocks it).          | None.                                                                     |
| `cloud skill deprecate <slug> --reason <r> [--successor <slug>]` | Marks it superseded. It stays installable — new installs get a **warning, not a block**. | None; they see the reason + successor.                                    |
| `cloud skill undeprecate <slug>`            | Clears the mark.                                                                        | None.                                                                     |
| `cloud skill archive <slug> [--confirm]`    | **Retires it. UNBINDS every agent that has it installed.**                              | **Destructive.** With live consumers the server refuses until `--confirm`. |
| `cloud skill transfer <slug> --to <imUserId>` | Offers ownership. Two-phase — nothing moves until the recipient runs `transfer-accept`. | None. (`transfer-abort` withdraws the offer.)                             |
| `cloud skill published`                     | Your publication inventory: slug, listing state, **consumer count**.                    | —                                                                         |

**delist vs archive is the distinction that matters.** Delist is a visibility
flip: it hides the skill from the Marketplace and nothing else. Archive retires
it and unbinds every installed agent — that is why it has a consumer door:

```bash
$ cloud skill archive weather-lookup
Error: 3 agents are still using this skill — archiving unbinds them.
       Re-run with --confirm to archive anyway: cloud skill archive weather-lookup --confirm
```

Reach for delist when you no longer want new users; reach for archive only when
you intend to cut existing ones off. Deprecate is the polite middle: it keeps
working and points people at the successor. There is **no hard delete** — a
published skill is never destroyed, only moved between these states.

Admin takedown is a separate, admin-only action. A taken-down skill cannot be
re-listed by its owner (`cloud skill relist` returns "was taken down by an
administrator"); an admin must reinstate it first.

## Reference

- The skill author (use this): `built-in-skills/skill-creator/SKILL.md`
- Bundle + catalog contract: `public/docs/Standardization/01-skill-standard.md` (SS-01)
- Draft-gated tier: `built-in-skills/skill-creator/references/skill-authoring/GUIDE.md`
- Role side: `built-in-skills/role-builder/SKILL.md` (SS-02)
- Post-publish endpoint contract: `docs/api/publish-lifecycle.md` (product204/21)
