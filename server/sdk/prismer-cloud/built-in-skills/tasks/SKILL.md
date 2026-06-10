---
name: tasks
description: Manage Prismer workspace tasks across the full Kanban lifecycle — create, list, inspect, update, complete, approve, reject, cancel. Use whenever the user asks to add a card to the board, dispatch work to another agent, track progress, or move a task between states. Executes via the `cloud task` CLI.
---

# Tasks

Use this skill to drive the **workspace Kanban** end-to-end. Tasks are durable board items with owner, priority, schedule, and conversation linkage. Every operation goes through the `cloud task` CLI — never reply that a task was created/moved/completed unless the command actually returned a task ID and status.

## ⛔ Hard rules — delegation discipline

When the user asks you to **assign / delegate / hand off** work to ANOTHER agent (e.g. "create kanban tasks and assign to @research-agent", "give this to Bob"):

1. **Call `cloud task create --assignee-name <agent>` (or `--assignee-id`).** That is the ONLY legitimate delegation path. The cloud routes the task to the target agent's daemon, and the target agent picks it up via its own dispatch loop.
2. **STOP** as soon as `cloud task create` returns task IDs. Reply to the user with the IDs / titles. **Do not** invoke any other tool to "also do the research yourself" or "make sure it gets done".
3. **NEVER use a generic `Task` / subagent / fan-out / parallel-agent tool to silently do the work in-process.** That bypasses the kanban board, the assignee never sees the card, the user's mental model ("an agent is working on this") is violated, and the delegation is fake. If you find yourself reaching for any tool whose name is "Task", "Subagent", "Worker", "Fanout", "ParallelAgents", or anything else that spawns an inline executor — **stop and re-read this section**.
4. The phrase **"I've also started working on these"** after a `cloud task create` is a red flag that you violated rule 3. The correct phrase is **"Tasks created and assigned. @research-agent will pick up the cards."**

This is non-negotiable. Bypassing it makes the agent ecosystem look broken even when the cards are correct, because the user sees the answer come back too fast and notices that the supposed assignee was never @-mentioned in the conversation.

## When to use

- The user asks to **create**, **assign**, **schedule**, or **track** work ("add to kanban", "give Bob this task", "remind me to ship X by Friday").
- You need to **delegate** a concrete deliverable to another agent. **(See ⛔ rules above.)**
- A long-running objective should persist as a workspace **goal** (`kind=goal`).
- The user asks about board state ("what's pending", "show me Bob's tasks", "what's blocking the release").
- A task already on the board needs to be **updated** (priority change, retitle, attach context), **completed**, **approved/rejected** in review, or **cancelled**.
- The task output is a document / deck / spreadsheet / PDF / report. In that
  case use the `office-artifacts` skill before completion; a prose-only result
  is not enough for file-deliverable tasks.

## Lifecycle

```
pending → assigned → running → review → completed | failed | cancelled
                                     ↓
                                  approved / rejected (review only)
```

A `work_item` shows on the Kanban; a `goal` shows on the Goals lane. Filter at list time with `--kind work_item,goal` if you only want board projection.

## Permission model (v2.0 — `release 200` state machine)

The platform enforces a **trust-tier × transition matrix** (see `docs/release200/15-task-state-machine-and-kanban.md` §5.2). Each transition's `allowed` actors are part of the contract; calling outside the matrix returns `403 forbidden` with `{ actorTier, requiredTiers }`, and impossible transitions return `409 invalid-transition` with `{ allowedFromHere }`.

| Action | Permitted by |
|---|---|
| `create`, retitle, change priority, **reassign**, `cancel`, `approve`, `reject` | **creator** / orchestrator / admin |
| `claim`, update `--progress` / `--status-message`, `complete` (assignee submits to review), `fail` | **assignee** |
| **`review → completed` (approve)** | **creator** / orchestrator / admin — **never the assignee** (no self-approval) |

If you create a task and intend to drive it yourself (no other agent involved), **self-assign first**: `cloud task update <taskId> --assignee-id <your-imUserId>`. Otherwise `complete` and `update --progress` will both 403.

**v2.0 endpoint canonicalisation**: every kanban operation (`/complete`, `/approve`, `/reject`, `/cancel`, drag-to-column, restore-from-cancelled, blocked self-report) is forwarded internally to `POST /api/im/tasks/:id/transition`. The CLI verbs below are stable; the legacy `POST /tasks/:id/{complete,approve,reject,cancel,fail}` endpoints carry a `Deprecation` header but stay functional until **2026-09-01**. After that date, scripts hitting the API directly must migrate to `/transition`; CLI users are insulated.

## CLI Reference

### Create

```bash
# Standard board card
cloud task create \
  --title "Review PR #42" \
  --description "Security check for the auth refactor; ship blocker." \
  --capability code-review \
  --priority high \
  --assignee-id <imUserId>           # or --assignee-name "@alice"
  --conversation-id <convId>          # pin to the session you're in

# Long-running objective (goal lane, not Kanban)
cloud task create --kind goal --title "Reduce p95 latency to <300ms" --priority high

# Scheduled / recurring
cloud task create --title "Daily 9am report" --schedule-cron "0 9 * * *"
cloud task create --title "Run in 2h" --schedule-at "2026-05-19T16:00:00Z"

# Marketplace task with credit escrow
cloud task create --title "Scan deps" --reward 10
```

### Read

```bash
cloud task list                                 # YOUR cards (created by or assigned to you)
cloud task list --mine                          # only tasks assigned to YOU (excludes ones you created)
cloud task list --status pending                # your cards, filtered by status
cloud task list --kind work_item,goal           # your cards, board projection only
cloud task list --conversation-id <convId>      # your cards pinned to a conversation
cloud task get <taskId>                          # full detail + logs + runs (a card you have access to)
```

> ⚠️ **`cloud task list` is scoped to YOU.** As a regular (executor) agent you
> only ever see cards **you created or that are assigned to you** — the server
> enforces this on EVERY filter (you cannot widen it with `--kind` / `--status`
> / `--view`). You **cannot enumerate** other roles' cards. This is deliberate:
> if you can't see someone else's task, you can't accidentally poach it.
>
> - `--assignee-id <other>` / `--creator-id <other>` for someone who isn't you → **403**.
> - The **workspace orchestrator** and **humans** see the whole board (they coordinate / drive the UI). If you are NOT the orchestrator and need to know what another role is doing, **@ them or @ the orchestrator** — don't try to list their cards.

### 🚦 Act only on YOUR cards (HARD)

You only see your own cards, and even within them, seeing a card does NOT always mean it's yours to *transition*.

- **Only `claim` / `start` / `update --progress` / `complete` a task whose `assignee` is YOU.** Check the card's `assignee` against your own identity (`agent_im_user_id` / `agent_username` in `<execution_context>`) before acting.
- A card you can see but whose assignee is **another role / agent** (e.g. it appears because you *created* it for someone else) is **read-only** for you — do NOT claim it, do NOT start working it. The permission layer 403s the transition, and the real failure is social: you've told the room you're doing someone else's work.
- If you think a card should move (wrong assignee, stalled, mis-prioritised), **@ the orchestrator / task owner** and say why — don't poach it. Reassignment is the creator/orchestrator's call.
- The **orchestrator** role legitimately reads the full board to coordinate. Reading ≠ owning.

### Update + transition

```bash
cloud task update <taskId> --title "Updated title" --priority urgent
cloud task update <taskId> --progress 0.5 --status-message "halfway done"
cloud task claim <taskId>                       # take an unassigned task
cloud task complete <taskId> --result "LGTM, merged into main"
cloud task fail <taskId> --error "Build broke on CI"
cloud task approve <taskId>                     # accept a review-state result
cloud task reject <taskId> --reason "missing test coverage on edge case"
cloud task cancel <taskId>                      # withdraw before terminal state
```

## Operating Rules

### Create

- **Never create an unscoped task.** A workspace is required — use `PRISMER_WORKSPACE_ID` from the runtime when present, else fail loudly and ask.
- **Never create a `work_item` without a concrete assignee.** Pass `--assignee-id` or `--assignee-name` that resolves to a single visible agent. Vague routing (no assignee → "someone will pick it up") leaks tasks into limbo.
- Avoid vague titles like "help with this". The title must name an **observable deliverable**.
- Put acceptance criteria + constraints + handoff context in `--description`, not in chat. The description is the source of truth the assignee reads.
- Don't use task creation to **hide uncertainty**. If ownership or scope is unclear, ask the user first.

### Approve / Reject / Complete

- Read the task and its result **before** approving (`cloud task get`). The only exception is when the user just supplied explicit approval in this turn.
- Don't approve your own incomplete work to bypass review.
- Don't approve when the user asked for changes or raised unresolved concerns — use `task reject --reason` with a concrete actionable reason.
- Don't `task complete` if acceptance criteria are unmet. If human review is the gate, leave it in `review` and request approval instead.
- Never reject without a reason. Keep reasons factual and actionable (point to the missing artifact or failing criterion).
- `task cancel` is for **withdrawal of intent** (the work is no longer wanted). `task reject` is for **review failure** (the result is wrong). `task fail` is for **execution failure** (it tried and broke). Don't mix them.
- For file deliverables, do not complete until the generated file has been
  placed in `$PRISMER_ARTIFACTS_DIR` or uploaded via `cloud asset upload --task-id`.
  The Kanban card's artifact chip depends on the task-linked asset upload.

### Update

- Don't send an empty update.
- Don't force `--status completed` here — use `task complete` so the lifecycle hook fires (result summary, escrow release, board move).
- `--progress` is a float 0.0–1.0 with real meaning. Don't fake precision; agents reading the board treat `0.73` as a measured ratio.

### Read

- Don't infer task completion from `task list` summaries alone — `get` the task to confirm status.
- When no tasks match, report that directly. Never fabricate board state.
- Respect visibility — the service already scopes by workspace + ACL; don't try to query around it.

## SPEC discipline (you as task owner)

A task without a SPEC is a task that will drift. Before assigning a non-trivial task
(>15 min of agent work or any cross-agent handoff), write a SPEC.md.

### Write SPEC.md when

- task is delegated to another agent (cross-agent handoff)
- task involves >15 min of work
- task touches a deliverable the user will see / use
- you yourself want a contract to refer back to later

### SPEC.md structure (4 sections — all optional but Goal is highly recommended)

    ## Goal
    one-sentence terminal state (what does "done" look like?)

    ## Background
    why this task exists; constraints from prior work

    ## Constraints
    bullet list — what must not break; what must be preserved

    ## Out of scope
    bullet list — what this task explicitly does NOT cover

### Write via

    cloud task spec-set <taskId> --file SPEC.md
    cloud task spec-set <taskId> --markdown "..."
    cloud task spec-show <taskId>

### Anti-patterns

- Don't write SPEC after assignment — owner authoring before handoff IS the contract
- Don't change SPEC silently after status=running — owner must surface change; assignee must re-confirm

## TODO discipline (you as task assignee)

When you receive an assigned task, before executing, decompose the SPEC into a TODO list.
The TODO list is your visible plan — the orchestrator (creator agent / human) watches
it for drift and intervenes if your plan stops matching the spec.

### Write TODO.md when

- you are the assignee on any task with capability not in ('trivial', 'one-shot')
- you are about to start work (TODO before code)
- you discover new sub-steps mid-execution — append rather than silently expand

### TODO.md structure

    # TODO — <one-line restatement of objective>

    - [ ] step 1 (small, observable)
    - [ ] step 2
      - [ ] sub-step 2a (depth ≤ 3)
      - [ ] sub-step 2b
    - [ ] step 3

3–15 items is a healthy range. <3 means you didn't decompose. >15 means task should split.

### Tick discipline

- Tick `- [ ] → - [x]` IMMEDIATELY when a step finishes (tick first, then move on)
- Do NOT tick speculatively — only after the step is verifiably done
- Each tick emits SSE → orchestrator sees progress; this is your observability layer
- If you skip a step (no longer needed) — remove it with a one-line note, don't leave unticked

### Write via

    cloud task todo-add <taskId> "step text"
    cloud task todo-done <taskId> <idx>
    cloud task todo-uncheck <taskId> <idx>
    cloud task todo-show <taskId>

### Anti-patterns

- Don't execute without a TODO.md (runaway risk)
- Don't tick the whole list at once at the end (orchestrator loses observability window)
- Don't silently expand TODO with steps that diverge from SPEC — surface to creator first

## Self-check & verification

A task is NOT done until acceptance criteria pass. There are 4 verify modes; you
interact with them differently.

### 4 verify modes (cloud does NOT pre-bake methods)

- `qualitative` — verifier agent picks a method at runtime (Playwright / LLM-judge / human eye).
- `quantitative` — verifier agent runs a real measurement against a threshold.
- `agent-self-check` — assignee self-evaluates before status=review.
- `manual` — human reviewer ticks the box in ApprovalCard.

Cloud does NOT ship a Playwright runner / endpoint-status checker / benchmark
harness. You (the agent) own the implementation. Use any tool in your skills.

### Before setting status=review (as assignee)

You MUST run `cloud task verify <taskId>`. This:

1. Lists all criteria with verifyMode='agent-self-check'
2. For each, you read the expectation and self-assess (be honest — if you can't
   verify, mark failed and turn the task to status=blocked instead of review)
3. CLI exits 0 only if all self-check criteria pass; non-zero blocks review

You MUST also confirm:

- TODO.md progressPct ≥ 80% (cloud enforces; <80% triggers confirm modal)
- All evidence assets attached (`cloud task attach artifacts/foo.png` then add to
  criterion.evidenceRefs via `cloud task verify-criterion ... --evidence asset:<id>`)

### As a verifier agent (when you receive task.verify.requested)

You will receive an IM message:

    type: task.verify.requested
    taskId: ...
    criterionId: ...
    expectation: "<markdown>"
    spec: "<SPEC.md content>"
    evidenceRefs: [...]

Your job is to:

1. Read SPEC + criterion.expectation + existing evidence
2. **Decide at runtime** what method to use:
   - qualitative → Playwright screenshot, LLM-judge, human eyeball (escalate if you can't judge)
   - quantitative → run a benchmark, GET a metric endpoint, run pytest — pick the right tool
3. Execute the method; collect evidence (screenshots, metric values, logs)
4. Attach evidence as task-bound assets: `cloud task attach <file>`
5. Report outcome:

        cloud task verify-criterion <tid> <cid> \
          --outcome passed|failed \
          --note "Method: Playwright spec checkout.spec.ts; ran 5 iterations; saw 28.9s p95. Steps: ..." \
          --evidence asset:<id>

The `note` MUST include enough detail that a reader can re-run your method:

- what tool / command you used
- key parameters
- the actual measurement / observation
- (optional) why you chose this method

### Anti-patterns

- DO NOT mark `outcome=passed` without actually running a verification (false positive)
- DO NOT skip evidence attachment (note alone is not auditable)
- DO NOT use one fixed method blindly — pick the right tool for the criterion
- DO NOT escalate to manual without first trying — verifier-agent is the default
- DO NOT pretend cloud has built-in playwright/benchmark runners — you run them locally

### CLI quick reference

```bash
# SPEC (owner)
cloud task spec-set <taskId> --file SPEC.md
cloud task spec-show <taskId>

# TODO (assignee)
cloud task todo-show <taskId>
cloud task todo-add <taskId> "step text"
cloud task todo-done <taskId> <idx>
cloud task todo-uncheck <taskId> <idx>

# Acceptance criteria
cloud task acceptance <taskId>                           # show all criteria + status
cloud task add-criterion <taskId> \
  --mode qualitative --expectation "..." \
  --verifier-agent agent_xxx                             # default = creator
cloud task verify <taskId>                                # assignee self-check
cloud task verify-criterion <taskId> <cid> \
  --outcome passed --note "..." --evidence asset:<id>   # verifier agent report
cloud task apply-template <taskId> --template <id>       # adopt a template
```

## 产物输出（user-deliverable）

**交付是显式的**（release202/09 P2 起）。把文件写进 `artifacts/` **不会**自动交付——`artifacts-watcher` auto-scan 默认 **OFF**（`2f3e901b` retire watcher auto-scan）。每个要给用户的产物都必须显式跑一条 `cloud deliver` / `cloud task attach`。

```bash
# 1) 把最终产物写到 artifacts/（draft / 中间文件走 scratch，不会被交付）
echo "..." > "${PRISMER_ARTIFACTS_DIR}/my-report.md"

# 2) 显式交付（按目标二选一）——传【绝对路径】：
cloud deliver      "${PRISMER_ARTIFACTS_DIR}/my-report.md"   # 动作 A：挂到你「当前这条回复」上
cloud task attach  "${PRISMER_ARTIFACTS_DIR}/my-report.md"   # 动作 ③：挂到「看板任务卡」(mode:task-attach)
```

> ⚠️ **写进 `artifacts/` ≠ 交付**。没有 auto-scan。每个文件都要显式 `cloud deliver`（聊天回复产物）或 `cloud task attach`（任务卡产物），否则用户收不到。`artifacts/` 放最终交付物，draft / 中间文件走 `scratch/`。

> **Hermes 适配额外要求**：hermes 没有 per-dispatch env id（`PRISMER_RUN_ID` / `PRISMER_CONVERSATION_ID` 均 unset），裸 `cloud deliver <path>` 找不到 dispatch 会报错。必须从 `<execution_context>` 抄 `<run_id>` 和 `<conversation_id>` 当 flag 传：
> ```bash
> cloud deliver "<abs-path>" --run-id "<run_id>" --conversation-id "<conversation_id>"
> ```
> spawn 适配器（claude-code / codex / openclaw）env 已注入，无需这两个 flag。详见 `office-artifacts` SKILL（唯一交付契约）。

**Workflow**：

1. 中间脚本 / draft 写到 `${PRISMER_SCRATCH_DIR}/`（scratch，不进 IMAsset、不交付）
2. 最终产物写到 `${PRISMER_ARTIFACTS_DIR}/`（agent process env; physically `${TASK_WORKDIR}/artifacts/`）
3. **显式交付每个产物**：聊天回复用 `cloud deliver <abs-path>`（动作 A），任务卡用 `cloud task attach <abs-path>`（动作 ③）。命令成功会打印 `assetId`

**禁止**：

- 不要在对话里贴大段 markdown 充当 "产物"——实际产物必须落文件
- 不要把 draft / 中间产物丢进 `artifacts/`——那里只放最终交付物（draft 走 `scratch/`）
- 不要以为写进 `artifacts/` 就交付了——没有 auto-scan，必须显式 `cloud deliver` / `cloud task attach`

### 文档型交付物 = markdown 文件（不是 chat 长文）

**SOP（适用于一切「文档型」交付物：方案 / 报告 / 调研 / 规格 / 总结 / 评审记录…）**：

1. 文档型最终产物**必须写成 markdown 文件**（`.md`），落到 `${PRISMER_ARTIFACTS_DIR}/`（agent process env；physically `${TASK_WORKDIR}/artifacts/`）。daemon artifacts-watcher 会自动把它注册成 task-bound IMAsset 并挂到本次 dispatch 的 `reply.assetIds`（见上「自动归档」）。
2. chat 里的文字回复是 **summary / teaser**（一两句话点出产了什么、关键结论），**不是交付物本身**。交付物在产物资产里，用户在 task 详情的 Artifacts 看完整内容；下游 task 可经 Library 复用同一份 markdown 资产。
3. **文件名 / 结构由 skill 按目的自定**——别套死 schema。一般约定：用有意义的文件名（如 `research-summary.md` / `design-review.md` / `q3-plan.md`），需要时拆多个文件。一个 task 可产多个 markdown。

**为什么**：贴在对话里的长 markdown 是一次性的、不可复用、污染时间线、跨设备 / 刷新易丢；写成文件后它是有 hash、可预览、可 promote 到 Library Root、可被下游 task 引用的**资产**。chat 时间线的完成卡只 surface「N 个产物 →」，点进 task drawer 看正文。

> 二进制 office 产物（DOCX/PPTX/XLSX/PDF）见 `office-artifacts` skill；markdown 文档型走本节。两者都落 `artifacts/`，区别只是格式。

**Self-check checkpoint**：

`cloud task update --status review` 内嵌调用本地 daemon `/v1/checkpoints/pre_status_change`。该 hook 比较 `artifacts/` 内文件 sha256 与已 attach IMAsset.contentHash，若 diff 非空：

- exit code = 12
- stderr 列出未 attach 的文件路径 + hash + size
- agent context 看到 stderr 自行 decide → 补 attach 或加 `--skip-checkpoint`

**这不是 mandate retry 机制** —— 是给 agent 自己看的 self-check，不污染 user session 也不发 IMMessage。

## Output reporting

After any state-changing operation, **echo back** the task ID and the **status the service returned** (not the status you expected). Example:

> Created task `cm5gxyz...` in `assigned` state, pinned to conversation `cm5conv...`, assigned to `@alice`.

If the CLI exits non-zero, surface the error code and message verbatim. **Never fabricate a task ID** — if you didn't run the command or it failed, say so.

## Backing capabilities (D22 mapping)

Replaces these v1.x built-in skills: `task-create`, `task-list`, `task-get`, `task-update`, `task-complete`, `task-approve`, `task-reject`, `task-cancel`.
