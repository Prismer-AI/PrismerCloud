---
name: skill-creator
scope: common
category: authoring
description: Create, import, edit, validate, test, or publish a Prismer SS-01 Skill. Use whenever a user asks to turn a repeatable capability or external Skill repository into platform Skills, improve an existing Skill, or make Skills available in Studio, a workspace, or Marketplace. Follow the fixed author-to-readback workflow and use bundled scripts for deterministic repeated work; do not explore raw endpoints or compose ad-hoc CLI chains.
license: Apache-2.0 AND MIT; see NOTICE.md
compatibility:
  - prismer-sdk
  - hermes
  - claude-code
  - codex
  - openclaw
metadata:
  category: authoring
  aliases: [skill-builder, skill-authoring]
  nativeReplaces: [hermes-agent-skill-authoring]
allowed-tools:
  - Read
  - Write
  - Bash
  - WebFetch
---

# Skill Creator

Historical skill-builder and skill-authoring installs resolve to this entry.
For low-level legacy formats only, see references/skill-builder/GUIDE.md and
references/skill-authoring/GUIDE.md. The current workflow below is authoritative.
For Hermes in-repository conventions, read
`references/hermes-agent-skill-authoring/GUIDE.md` only when targeting a verified
Hermes checkout. It is a full MIT-licensed reference, not a second entrypoint.
The bundled Anthropic authoring resources retain Apache-2.0 in LICENSE.txt.

Choose one route and execute it directly. Do not inspect `cloud --help`, create
probe catalog objects, or call raw Skill endpoints first.

| Requested result                               | Route                                                        |
| ---------------------------------------------- | ------------------------------------------------------------ |
| one new or edited Skill                        | [Single bundle](#single-bundle)                              |
| repository/directory containing several Skills | read `references/external-library-import.md`, then follow it |
| improve or benchmark a Skill                   | [Improve](#improve-an-existing-skill)                        |
| create a role/persona/job template             | stop and use `role-builder`                                  |

## Ownership boundary

Optional paid trigger/description evaluations require explicit budget approval
and `PRISMER_ALLOW_PAID_EVAL=1`. Trigger probes use isolated temporary skill
directories, Read/Skill only, 0.25 USD per query and a 300-call batch ceiling.
Use a current Claude CLI supporting `--bare` and budget flags; unsupported CLI,
timeout, auth failure, or missing terminal result is an error, not a negative
trigger. Do not bypass nested-session or authentication guards. Viewer HTML
is local; spreadsheet preview additionally uses its declared external SheetJS
script and is not guaranteed offline. Static feedback is downloaded explicitly.

Keep each concern in its proper layer:

- Product resource operations belong in the service/SDK/CLI.
- A stable, repeated transformation or multi-step workflow belongs in a
  bundled `scripts/` harness.
- SKILL.md routes intent, declares configuration, invokes the script, and
  explains the result. It should not make every future Agent rediscover the
  same command sequence.

Promote a script into the CLI only when several independent clients need the
operation as a reusable product primitive. Do not add a CLI verb merely to
shorten one Skill workflow.

## Single bundle

Create or edit this shape:

```text
<skill-slug>/
├── SKILL.md
├── skill.json          # only when samples/security metadata are needed
├── scripts/            # deterministic or repeated work
├── references/         # details read only when needed
└── assets/             # output templates/resources
```

Minimum SKILL.md:

```markdown
---
name: example-skill
description: Describe what it does and concrete situations that should trigger it.
license: MIT
---

# Example Skill

State the shortest reliable workflow, required inputs, output contract, and
failure behavior.
```

Keep the directory name and frontmatter `name` equal. Preserve the name when
editing an installed Skill. Put detailed variants in `references/`; keep the
triggered body short enough to scan once.

### Configuration

Declare reusable Skill configuration in frontmatter and read values only from
the script subprocess environment:

```yaml
config:
  - key: SERVICE_API_KEY
    type: secret
    required: true
    default: null
    bindable: [global, role, agent]
    description: Credential used by the service client.
```

Valid types are `string`, `secret`, `url`, and `enum`. Numeric knobs are
strings parsed by the script. Never put a value in SKILL.md, a role, a command
argument, a ledger, or model-visible output.

Configuration ownership is strict:

| Need                      | Owner                        | Delivery               |
| ------------------------- | ---------------------------- | ---------------------- |
| reusable Skill config     | Skill `config:`              | Skill subprocess env   |
| role default/behavior     | role `parameters[]`          | structured role params |
| per-account secret        | `kind:"user", type:"secret"` | sealed env-only params |
| role default for a Skill  | role `skillConfig[slug]`     | resolved Skill env     |
| workspace identity/policy | workspace APIs               | runtime bootstrap      |
| deployment secret         | daemon/deployment env        | child process env      |

### Script harness negative controls

When a script writes remotely, it must carry enough harness weight to reject a
bad request before the first network call:

1. Validate required input, types, target, and environment locally.
2. Reject secret-bearing flags, including `--token=value`; do not echo the
   untrusted token or value in an error.
3. Read credentials and remote-write authority only from trusted environment
   variables. A flag must not self-authorize a remote write.
4. Run a read-only server preflight before mutation when one exists.
5. Establish a stable idempotency key for recovery and write a secret-free,
   atomic ledger before the first mutation.
6. Emit structured stage/code/retryability output. Retain incomplete cleanup
   state instead of claiming success.
7. Test at least one negative control proving invalid local input performs zero
   fetches/writes.

## Fixed authoring closure

Run in this order:

```bash
cloud skill validate ./<skill-slug> --json
cloud skill test ./<skill-slug> --agent <agentImUserId> --json
```

`validate` is local and mandatory. Run `test` when `skill.json` declares
`sampleTasks[]`; otherwise it may report a clear skip. Fix failures before any
create or publish request.

Choose exactly one destination:

```bash
# Private, active, immediately installable in this workspace
cloud skill create ./<skill-slug> --json

# Private draft for Studio human review
cloud skill draft create ./<skill-slug> --json

# Public Marketplace: first create private, then publish returned slug
cloud skill create ./<skill-slug> --json
cloud skill publish <returned-slug> --license <license> --json
```

Use the server-returned canonical slug. Community Skills may receive a prefix;
never reconstruct it from the directory name. Verify private objects through
the owner domain, not public search:

```bash
cloud skill mine --json
cloud skill show <returned-slug-or-id> --content --json
```

A `409` is not proof that the intended Skill already exists. Read the owned
object and compare it before resuming or choosing a new name. If a documented
command is absent, report CLI version skew and use the repository's current
Cloud build; do not silently bypass gates with raw HTTP.

## External Skill libraries

For more than one source Skill, read
`references/external-library-import.md`, set its small environment contract, and
run `node scripts/import-library.mjs --json`. The harness validates the complete
selected tree before writes, rejects mirror slug collisions, resumes through a
secret-free ledger, owner-readbacks every canonical slug, and emits the exact
`requiredSkills` array for `role-builder`. Never replace it with a hand-written
shell loop, publish a probe object, or apply a role to the currently executing
Agent for verification.

## Improve an existing Skill

Default to a small evidence loop, not a large benchmark ceremony:

1. Preserve the original bundle and name.
2. Choose 2–3 representative prompts and explicit success checks.
3. Validate, run, inspect outputs, and revise only observed failure causes.
4. Re-run the same checks and ask for user review when output quality is
   subjective.

Only when the user requests a formal benchmark or trigger optimization, use
the bundled resources:

- `references/schemas.md` for eval/result schemas.
- `scripts/run_eval.py`, `scripts/aggregate_benchmark.py`, and
  `eval-viewer/generate_review.py` for comparison/review.
- `scripts/run_loop.py` and `scripts/improve_description.py` for explicit
  description optimization.
- `agents/grader.md`, `agents/analyzer.md`, and `agents/comparator.md` only for
  the corresponding advanced evaluation step.

Do not load all advanced resources for ordinary creation or import.

## Built-in baseline boundary

Skill authors define a capability; they do not decide that every Agent must
receive it. A community/private Skill cannot self-enrol into the mandatory
baseline. A platform Built-in is eligible only through the platform tier
registry, and Admin selects/version-controls the active common and orchestration
sets in `/admin/skills`.

Role authors declare only business Skills. Role creation injects the active
baseline and exposes `requiredSkills`, `injectedSkills`, `effectiveSkills`, and
`baselinePolicyVersion`. If a proposed baseline Skill requires an unresolved
user secret, report it as ineligible; never weaken preflight or embed the value.

## Completion report

Report only evidence the user can act on:

- validation/test result;
- selected destination and returned canonical slug/version/status/scope;
- readback result;
- for batch import, selected/excluded source trees and created/failed ledger
  counts;
- any missing configuration by variable name only;
- whether a role handoff or live Agent mutation was explicitly requested.
