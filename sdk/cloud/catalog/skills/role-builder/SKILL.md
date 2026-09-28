---
name: role-builder
scope: common
category: authoring
description: Create or update a Prismer SS-02 role template from a persona, SOP, job description, or operating brief; instantiate an existing role as a new working agent and run its first task through the bundled one-command harness. Use for "create a role template", "make this role into an agent", "create an agent from this role", or "let this role handle a task". Route standardized instantiate-and-run requests to the script instead of discovering and composing low-level CLI commands.
license: MIT
compatibility:
  - prismer-sdk
  - hermes
  - claude-code
  - codex
  - openclaw
metadata:
  category: authoring
allowed-tools:
  - Read
  - Write
  - Bash
  - WebFetch
---

# Role Builder

Choose exactly one path from the requested outcome. Do not inspect `cloud
--help`, create probe assets, or compose low-level commands first.

## A. Existing role → new working agent → first task

Run the bundled harness directly:

```bash
node scripts/instantiate-and-run.mjs --json
```

Required environment:

- `PRISMER_API_KEY`
- `PRISMER_CLOUD_BASE`
- `PRISMER_ROLE_SLUG`
- `PRISMER_WORKSPACE_ID`
- `PRISMER_TASK`

Optional environment:

- `PRISMER_AGENT_HANDLE`, `PRISMER_AGENT_DISPLAY_NAME`,
  `PRISMER_AGENT_ADAPTER`, `PRISMER_TARGET_DAEMON_ID`
- `PRISMER_REQUEST_ID`, `PRISMER_OPERATION_LEDGER`
- `PRISMER_WORKFLOW_TIMEOUT_MS`, `PRISMER_WORKFLOW_POLL_MS`
- `PRISMER_ALLOW_REMOTE_WRITE=1` for an explicitly confirmed non-local target

The runtime must inject these variables before the turn. Never ask the user to
paste a credential into chat and never pass one as a command-line flag.

The harness validates locally, performs server preflight, creates/resumes the
role-backed agent, waits for its exact daemon binding, creates one idempotent
task, and waits for the canonical result. `--no-wait` skips only the final task
result wait. `--preflight-only` performs no mutation.

If it returns `ROLE_CONFIG_REQUIRED`, report the missing level, target, and key
names exactly. Do not guess values:

- `level=skill` or `level=role`, user-owned key: the owner supplies it through
  Studio or `POST /api/im/user-skill-config`; values are sealed and never enter
  the model prompt.
- role default: edit the role's `parameters[]` declaration/default.
- global-only Skill key: inject it into the daemon/deployment environment.
- workspace/runtime issue: repair the named workspace or daemon; do not create
  a different workspace as a workaround.

## B. Material → role template

Create a directory with exactly the role definition and persona:

```text
<role-slug>/
├── role.json
└── SOUL.md
```

`role.json` is the SS-02 governance manifest. `SOUL.md` is persona only; do
not put credentials, per-run instructions, or an `AGENTS.md` in the role bundle.

Minimum useful `role.json`:

```json
{
  "slug": "legal-expert",
  "version": "1.0.0",
  "name": { "en": "Legal Expert", "zh": "法学专家" },
  "description": { "en": "Analyzes legal matters.", "zh": "分析法律事项。" },
  "agentType": "specialist",
  "requiredSkills": [{ "skillSlug": "legal-article-retrieval", "required": true }],
  "taskAuthority": "executor",
  "approvalPolicy": "auto-low-risk",
  "parameters": [],
  "adapters": { "hermes": {} },
  "source": "community",
  "curatedQuality": "review"
}
```

Use catalog slugs returned by the Skill create/import result. Never derive a
slug from a directory name, case-normalize it after creation, or invent one.
Build missing skills with `skill-creator` first.

Declare only role-specific business skills in `requiredSkills`. The active
Admin Built-in Skill baseline is injected automatically at template creation
and re-resolved when an Agent is instantiated. Do not copy system skills into
the role manifest and do not attempt to remove an injected skill. Readback
separates `requiredSkills`, `injectedSkills`, and `effectiveSkills`, plus the
`baselinePolicyVersion` used for the snapshot.

Put the bundle path in `PRISMER_ROLE_BUNDLE`, then run the fixed authoring
closure as one command:

```bash
node scripts/author-role.mjs --json
```

Optional environment: `PRISMER_ROLE_PUBLISH=1` for an explicitly requested
Marketplace publish, `PRISMER_ROLE_AUTHORING_LEDGER`, `PRISMER_CLOUD_BIN`,
`PRISMER_CLOUD_BASE`, and `PRISMER_ALLOW_REMOTE_WRITE=1` for a confirmed
non-local target. The harness performs local validation, read-only required
Skill preflight, private create/owner-update, and owner readback. It resumes a
completed same-revision ledger without pushing another role version. Report the
returned slug/version; do not use `role apply` as a test.

The clean lower-level primitives remain available for diagnosis:

```bash
cloud role validate ./<role-slug> --json
cloud role test ./<role-slug> --json
cloud role create ./<role-slug> --mine --json
cloud role show <returned-slug-or-id> --json
```

For the retained legacy entrypoint (requires the current Cloud CLI; no raw HTTP fallback):

```bash
node scripts/ingest-role.mjs ./<role-slug> --mine
```

It reads `PRISMER_API_KEY` and `PRISMER_CLOUD_BASE` from the already-injected
environment. Do not write literal secrets in the command, bundle, or ledger.
The adapter delegates validation and Skill preflight to Cloud before creation.
Ledger-based workflows require an injected API key even if Cloud has saved
credentials: the target origin and that executing key's hash bind every receipt.
Changing either requires a separate ledger. Completed receipts are read back,
not blindly trusted. A lock is never stolen on timeout; after a crash, verify
the old process has stopped and reconcile remote writes before explicit recovery.

## C. Change an existing agent's role

Only when the user explicitly identifies an existing target:

```bash
cloud role apply <role-slug> --agent <imUserId> --workspace-id <workspaceId>
```

Never apply a role to the currently executing agent as a probe. Template
creation is complete after validation, dependency test, ingest, and readback;
it does not require mutating a live agent.

## Configuration ownership

Declare each value once at the level that owns it:

| Need                              | Owner/declaration                                 | Delivery                         |
| --------------------------------- | ------------------------------------------------- | -------------------------------- |
| reusable Skill config             | Skill frontmatter `config:`                       | Skill subprocess env             |
| role behavior/default             | role `parameters[]`, `kind:"default"`             | structured `roleParams`          |
| per-account role secret           | role `parameters[]`, `kind:"user", type:"secret"` | environment-only `roleParamsEnv` |
| role default for a required Skill | role `skillConfig[skillSlug]`                     | resolved Skill env               |
| workspace identity/policy         | workspace fields and policy APIs                  | server/runtime bootstrap         |
| workspace runtime secret          | daemon/deployment env                             | child process env only           |
| invocation target/recovery        | `PRISMER_WORKSPACE_ID`, daemon/request/ledger env | harness request only             |

Do not duplicate values across Skill prose, role persona, workspace metadata,
and workflow flags. Workspace metadata is not a secret store.

## Harness negative-control contract

The bundled mutation harness must keep these guarantees:

1. Secret-bearing flags, missing/invalid local input, and unconfirmed remote
   writes fail locally before any fetch.
2. Server preflight rejects inaccessible/non-deployable roles, missing config,
   handle collisions, and absent runtime before creating an operation or agent.
3. Instance and task writes carry durable idempotency keys. Instance retries
   return the same operation and reject changed instance input with 409; task
   retries return the first committed task and reject changed task input with 409. Derived task keys are fixed-length hashes, so a 191-character instance
   request ID cannot overflow the task contract. A new invocation gets a fresh
   request ID; set `PRISMER_REQUEST_ID` only to resume that same invocation.
4. A secret-free ledger is written atomically before mutation. Output contains
   stage, code, retryability, and recovery path—never credentials. Reusing the
   ledger path with a different invocation hash is rejected before fetch.
5. Provisioning failure compensates the newly created agent. Incomplete cleanup
   remains `cleanupStatus=pending` with the Agent pointer retained and retryable;
   it must never be reported as cleaned. Task failure keeps a valid agent for
   diagnosis/retry.
6. `ready` means the Agent is bound to the exact requested daemon. A
   `wrong_daemon` binding fails explicitly and cannot advance to task creation.

## Sources of truth

- Role standard: `public/docs/Standardization/02-role-template-standard.md`
- Harness standard: `public/docs/Standardization/16-automation-harness-standard.md`
- Complete catalog example: `sdk/cloud/catalog/roles/team-manager.json`
- Skill authoring/import: `sdk/cloud/catalog/skills/skill-creator/SKILL.md`
