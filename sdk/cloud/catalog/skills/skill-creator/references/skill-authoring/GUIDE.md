---
name: skill-authoring
scope: common
description: Low-level helper for the DRAFT-GATED (review) tier of skill authoring — it is NOT the entry point for creating skills. To make/build/author a skill, use `skill-creator` (the single canonical skill author). This page only documents skill-creator's draft tier — generating a `status=draft` skill via `POST /api/im/skills/draft` (`cloud skill draft create`) for human review in Studio Authoring, plus the skill.json + sampleTasks/acceptanceCriteria test contract. Do NOT route here when the user wants to create a skill — route to skill-creator and add `--draft` only when human review is required.
license: MIT
compatibility:
  - prismer-sdk
  - hermes
  - claude-code
  - codex
---

# Skill Authoring — the draft-gated tier of `skill-creator`

> **Not an authoring entry point.** Creating or editing a skill is the job of
> **`skill-creator`** — the single canonical skill author. This page only
> documents one of skill-creator's two publish trust tiers (**draft-gated**),
> for the case where a skill must be reviewed by a human before it goes live.
> If the user says "make this a skill" / "create a skill for X", **use
> `skill-creator`**, not this.

## Where this fits

`skill-creator` drives the full lifecycle author→validate→test→package→publish.
At the publish step there are two trust tiers ([[16-skill-role-authoring-as-agent-capability]] §5.3):

- **Direct create (default)** — `cloud skill create ./<dir>` → `status=active`,
  `publishScope=workspace` (**private**, installable — NOT the public marketplace).
  Putting it in the marketplace is a separate `cloud skill publish`. Under `skill-builder`.
- **Draft-gated (explicit, this page)** — `cloud skill draft create` →
  `status=draft`, Studio Authoring reviews and promotes it. Opt into this **only
  when human review is required** — the default is direct publish (decision 4,
  locked 2026-06-24).

Both tiers are reached from inside `skill-creator`; this is a publish-verb
choice, not a separate skill to author in.

## Draft submission (the review-gated path)

When the workflow requires human review before a skill is live, submit a draft
instead of publishing directly:

```bash
cloud skill draft create ./<bundle-dir>   # optional: --workspace-id <id> --json
# → POST /api/im/skills/draft. Cloud reads the directory, runs the 7 validation
#   gates, and returns { id, slug, status: draft }. Does NOT publish.
```

> ⚠️ **`<bundle-dir>` is a directory** holding `SKILL.md` + `skill.json` (+ an
> optional `scripts/`). The CLI reads and packages the directory on every run, so
> edits on disk take effect immediately — there is no separate manifest to
> regenerate. There is **no** `--slug` / `--manifest` flag; the slug is taken from
> the SKILL.md frontmatter `name`.

The draft lands in `status=draft`; the workspace owner reviews and promotes it
via Studio Authoring (`/evolution → Studio → Authoring`). Do **not** auto-publish
or chain into install — promotion is the owner's call.

> Do NOT call `POST /api/im/skills` (direct publish) when the intent is review-gated —
> that bypasses the draft state. Use `--draft` deliberately.

## `skill.json` — where security + the test contract live

**Read this first — it is the #1 draft-tier gotcha.** The bundle must contain a
`skill.json` alongside `SKILL.md` (cloud locates each file by name, so a
`scripts/` dir sorted in between is fine). Cloud reads `security` and the test
contract from **`skill.json`**, and **NEVER** from the `SKILL.md` YAML
frontmatter. If you put `security:` / `dataAccess:` in the
SKILL.md frontmatter, gate 5 still fails with "security.dataAccess must be
non-empty" no matter how you format the YAML — it is reading a different file.

### `security` (blocking — gate 5)

```json
{
  "schemaVersion": 1,
  "slug": "<slug>",
  "security": {
    "dataAccess": ["workspace-assets"],
    "humanApprovalRequiredFor": []
  }
}
```

- **`security.dataAccess`** — non-empty array. Scopes: `workspace-assets` |
  `memory` | `external-network` | `secrets` | `filesystem`.
- **`security.humanApprovalRequiredFor`** — **required non-empty IF** `dataAccess`
  contains a **sensitive** scope (`external-network`, `secrets`, `filesystem`).
  List the actions needing human approval (e.g. `["filesystem-write"]`).
- **Least privilege:** if the skill only reads env + prints (no arbitrary user
  files), declare `["memory"]` — a non-sensitive scope — and
  `humanApprovalRequiredFor` may stay empty. Only reach for `filesystem` when the
  skill genuinely reads/writes user files, and then you must also declare
  approval.

### test contract (drives `cloud skill test`)

The same `skill.json` also carries the VERIFICATION contract exercised by
`cloud skill test --agent` in lifecycle step ③:

- `runtime.kind` = `'inline-script'` (or `'http-endpoint'`), `runtime.requires`
  declaring `bins`/`env` the script needs.
- `inputs` / `outputs` describing the call contract.
- **`sampleTasks[]`** — at least 2 concrete tasks. EACH MUST have
  `acceptanceCriteria[]` written as substrings/regex the dispatch OUTPUT must
  contain (e.g. `"\"status\":\\s*200"`, `"results"`). These are the auto-scored
  tests: `cloud skill test` dispatches each sampleTask to a real agent and
  matches its output against the criteria. A sampleTask with no
  acceptanceCriteria scores `inconclusive` (NOT a pass), so always write them.

> Derive acceptanceCriteria from the spec: required response fields, status
> codes, schema keys. Tight enough to catch a broken call, not so tight they
> depend on volatile data.

## Draft validation gates (self-check before submit)

The cloud server runs these at `createDraft` time and rejects with HTTP 400 on a
blocking failure. Run the same checks locally first (or just `cloud skill validate ./<dir>`):

| Gate           | Check                                                            | Blocking |
|----------------|------------------------------------------------------------------|----------|
| `manifest`     | files[] complete; merkle root reproducible                       | yes      |
| `frontmatter`  | `name` matches `^[a-z][a-z0-9-]*$`; description ≥ 50 quality units (ASCII=1, non-ASCII=2); YAML `|`/`>` supported | yes      |
| `package`      | bundle contains SKILL.md + skill.json (located by name)          | yes      |
| `requires`     | runtime.requires declares env/bins/python/node explicitly        | warn     |
| `security`     | **skill.json** security.dataAccess non-empty; sensitive scopes (external-network/secrets/filesystem) require security.humanApprovalRequiredFor. NOT read from SKILL.md frontmatter. | yes      |
| `sample`       | at least 1 sampleTask + 1 acceptance criterion                   | warn     |
| `runtime`      | sandbox executes sample task                                     | deferred |

## Reference

- The skill author (use this): `built-in-skills/skill-creator/SKILL.md`
- Direct-publish tier: `built-in-skills/skill-creator/references/skill-builder/GUIDE.md`
- Bundle + catalog contract: `public/docs/Standardization/01-skill-standard.md` (SS-01)
