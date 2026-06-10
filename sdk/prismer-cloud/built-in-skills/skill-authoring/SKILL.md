---
name: skill-authoring
description: Generate Prismer-compliant skill drafts from user intent, documentation URLs, existing code, or service endpoints. Use whenever the user says "make this a skill", "package this workflow", "create a skill for X", or wants to capture a repeatable workflow into a reusable artifact. Outputs a multi-file manifest (SKILL.md + skill.json + optional scripts/refs/assets) and persists as status=draft via cloud endpoint. Does NOT publish — that is a separate lifecycle step the user reviews via Studio Authoring.
license: MIT
compatibility:
  - prismer-sdk
  - hermes
  - openclaw
  - claude-code
  - codex
---

# Skill Authoring (Prismer)

You generate Prismer-standard skill drafts. You do NOT publish — that's a separate
lifecycle step the user reviews via Studio Authoring (`/evolution → Studio → Authoring`).

## Pipeline

1. **Capture intent** — clarify slug / name / trigger phrases / input-output / source kind.
   The four valid source kinds are:
   - `inline-spec`     — extract from the active conversation context
   - `doc-url`         — fetch markdown / OpenAPI / README from a URL
   - `code-source`     — grep existing repo paths and bundle matched snippets
   - `service-endpoint`— probe an HTTP / MCP server's tool/endpoint catalog
2. **Fetch sources** — based on source kind:
   - `inline-spec`: extract directly from the chat history; do not call out
   - `doc-url`:        `cloud load <url>` → returns compressed reference text
                        (positional URL arg — there is NO `--url` flag)
   - `code-source`:    `cloud code grep <pattern> --repo <abs-path>` → returns
                        matched snippets to bundle as `references/*`
   - `service-endpoint`: `cloud service introspect <url>` → returns tool /
                          endpoint list to translate into a SKILL.md workflow
3. **Compose manifest v1** — write:
   - `SKILL.md` (frontmatter `name`/`description`/`license`/`compatibility` +
     a body that follows Anthropic skill-creator's progressive-disclosure pattern)
   - `skill.json` (structured `SkillPackageSpec` — see release201/07 §2.6)
   - Optional `scripts/`, `references/`, `assets/`
4. **Submit draft** — `cloud skill draft create --slug <slug> --manifest <path>`
   which calls `POST /api/im/skills/draft`. The cloud server runs the 7 validation
   gates and returns `{ id, slug, manifestRevision, reviewTaskId }` on success.
5. **Report draft id** — surface the draft id back to the user; do NOT auto-publish.

## Scenario 1 — API doc / URL → skill + callable script + auto tests

This is the canonical, quantifiable path (release201/24). When the user gives
you an API document, an OpenAPI/Swagger spec, or a doc URL and asks to "make
this a skill", produce a draft that can be VERIFIED by real dispatch — not just
prose. Generate ALL of:

1. **`SKILL.md`** — workflow describing when/how to call the API, with the
   concrete endpoints, auth, and the script entrypoint.
2. **`scripts/call-api.*`** — a real, runnable script (Node `.ts`/`.mjs`, or
   `.sh` using curl) that performs the API call. Read inputs from argv / env;
   print the result to stdout. This is what the eval session actually exercises.
3. **`skill.json`** — the `SkillPackageSpec` with:
   - `runtime.kind = 'inline-script'` (or `'http-endpoint'`), `runtime.requires`
     declaring `bins`/`env` the script needs (e.g. `env: ["EXAMPLE_API_KEY"]`).
   - `inputs` / `outputs` describing the call contract.
   - **`sampleTasks[]`** — at least 2 concrete tasks. EACH MUST have
     `acceptanceCriteria[]` written as substrings/regex that the dispatch
     OUTPUT must contain (e.g. `"\"status\":\\s*200"`, `"results"`). These ARE
     the auto-generated mock tests — the daemon scorer matches them against the
     real dispatch output (release201/24 §2.1). A sampleTask with no
     acceptanceCriteria is scored `inconclusive` (NOT a pass), so always write
     them.
4. **`references/<api>.md`** — the compressed `cloud load <url>` /
   `cloud service introspect <url>` output, so the workflow is grounded.

Quantifiable acceptance: the skill is "good" when its eval run pass-rate (real
dispatch of each sampleTask, scored against acceptanceCriteria) meets the
lifecycle threshold. Write criteria that are tight enough to catch a broken
call but not so tight they depend on volatile data.

> Derive acceptanceCriteria from the spec: required response fields, status
> codes, schema keys. If the spec lacks examples, add a criterion asserting the
> script exits 0 and emits non-empty JSON, plus a field-presence check.

## Boundaries

- DO NOT call `POST /api/im/skills` directly — it bypasses draft state
- DO NOT modify existing non-draft skills (use `skill-creator` reference if the
  user asks "edit existing skill")
- DO NOT trigger publish / share — the user reviews drafts in Studio Authoring
- Reference Anthropic skill-creator at `/built-in-skills/skill-creator/SKILL.md`
  for "how to write a good SKILL.md" patterns (progressive disclosure, allowed
  tool surface, etc.). Treat it as documentation, not as an executor.

## Quality gates (self-check before submit)

The cloud server runs the 7 gates below at `createDraft` time and rejects with
HTTP 400 on any blocking failure. Run the same checks locally before POSTing:

| Gate           | Check                                                            | Blocking |
|----------------|------------------------------------------------------------------|----------|
| `manifest`     | files[] complete; merkle root reproducible                       | yes      |
| `frontmatter`  | `name` matches `^[a-z][a-z0-9-]*$`; description ≥ 50 chars       | yes      |
| `package`      | SKILL.md is files[0]; skill.json is files[1]                     | yes      |
| `requires`     | runtime.requires declares env/bins/python/node explicitly        | warn     |
| `security`     | security.dataAccess non-empty; sensitive scopes require approval | yes      |
| `sample`       | at least 1 sampleTask + 1 acceptance criterion                   | warn     |
| `runtime`      | sandbox executes sample task                                     | deferred |

- `name` matches `^[a-z][a-z0-9-]*$`
- `description` ≥ 50 chars, contains trigger context ("Use when...")
- SKILL.md body ≤ 500 lines (progressive disclosure)
- All scripts/refs/assets paths exist in manifest files[] array
- Merkle root computed correctly:
  `sha256(join("\n", sorted(files, by=path).map(f => path + ":" + sha256)))`

## Output contract

After a successful submit, return to the user:

```
Draft submitted.
  id:               <skill id>
  slug:             <slug>
  manifest revision <merkle>
  review task:      <task id>  (capability=skill-review, assignee=workspace owner)
  next step:        Open in Studio Authoring → review → promote to eval (release201/08)
```

Do NOT chain into install / publish; lifecycle is the workspace owner's call.
