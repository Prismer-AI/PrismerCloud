---
name: okr
scope: persistence
description: Draft and track a strategic OKR charter — turn a human's plain-language goal into ONE Objective + 2-5 measurable Key Results, link existing tasks, and route the commit to a human sponsor. Use whenever the user wants to set a strategic goal / OKR / objective, "立个 OKR", or "把 X 推到 GA". Executes via the `cloud okr` CLI.
---

# OKR

Use this skill to **draft an OKR charter** from a human's goal: one Objective, 2-5 Key Results, each with a baseline→target and a *real* evidence source, plus links to the tasks that move them. Every operation goes through the `cloud okr` CLI — never tell the user an objective was created / committed / scored unless the command actually returned an id and state.

You **draft and propose**. The human **commits**. That split is the whole point of this skill (see ⛔ hard rules).

## When to use

- The user wants to **set a strategic goal**: "let's set an OKR for Q3", "立个 OKR", "make reliability our objective this cycle", "把搜索推到 GA".
- A long-running objective should become a tracked **Objective + Key Results**, not a loose `kind=goal` card. (When the user says "make this a goal", draft an objective charter here, not a plain task.)
- You need to **link** existing tactical tasks to the Key Result they serve.
- The user wants to **see OKR health** — the objective tree with KR progress.

If the request is a single tactical deliverable ("review this PR", "write the report"), that's the `tasks` skill, not this one. Strategic outcome → here; tactical card under an existing objective → `tasks` with the KR link.

## Charter drafting methodology

From a human's plain-language goal, draft **ONE Objective + 2-5 Key Results**. Before drafting, ask for whatever is missing:

- **Outcome** — what observable end-state defines success? (the Objective title)
- **Deadline / cycle** — which cycle does this belong to? (`--cycle 2026-Q3`)
- **Owner** — which agent/human drives it? (`--owner <imUserId>`)
- **Sponsor** — which **human/admin** stands behind it? (`--sponsor <human imUserId>`) — **required for a committed objective.**
- **Per KR**: a baseline → target, and a **measurable source**. Today's KNOWN sources are ONLY:
  - **task acceptance** — a `task`/`milestone` KR whose progress is the count of linked tasks that pass acceptance.
  - **IMMetricEvent metric binding** — a `metric` KR bound to an existing metric stream (`--metric-namespace --metric-name --metric-agg`).
  - **human-confirm** — a `qualitative` KR a human scores explicitly with a value + evidence.

Then:

1. **Draft the objective** (agent proposes — it is NOT yet committed):

   ```bash
   cloud okr objective create \
     --workspace "$PRISMER_WORKSPACE_ID" \
     --title "Search is GA-ready" \
     --type committed \
     --narrative "Definition of done: search ships to all users with p95 < 300ms and zero P0s." \
     --cycle 2026-Q3 \
     --owner <imUserId> \
     --sponsor <human imUserId>
   ```

2. **Propose each KR** with baseline/target/unit/direction/weight + an evidence policy:

   ```bash
   # metric-backed KR (bound to a real IMMetricEvent stream)
   cloud okr kr add <objectiveId> \
     --title "p95 search latency under 300ms" \
     --type metric --baseline 480 --target 300 --unit ms --direction decrease --weight 2 \
     --metric-namespace search.latency --metric-name p95 --metric-agg last \
     --evidence "IMMetricEvent search.latency:p95, last value per cycle"

   # task-backed KR (progress = linked tasks that pass acceptance)
   cloud okr kr add <objectiveId> \
     --title "Ship 4 launch-blocker fixes" \
     --type task --baseline 0 --target 4 --direction increase \
     --evidence "count of linked tasks with passing acceptance"
   ```

3. **Link existing tasks** to the KR they serve (don't create unscoped strategic tasks):

   ```bash
   cloud okr link <objectiveId> <keyResultId> <taskId>
   ```

4. **STOP and hand the commit to the human sponsor.** Print the objective id + KR ids and say: *"Charter drafted. @<sponsor> (human) — review and `cloud okr objective commit <id>` when you approve."* Do **not** commit it yourself.

## ⛔ Hard rules

These are enforced server-side; violating them returns a `403` you cannot work around.

1. **NEVER commit an objective yourself.** `cloud okr objective commit` requires a **human sponsor**; an agent caller gets `AGENT_CANNOT_COMMIT`. Your job ends at *draft + propose*. Surface the objective and ask the human sponsor to commit.
2. **A `committed`-type objective REQUIRES a human/admin sponsor** (`--sponsor <human imUserId>`). Without one, commit returns `SPONSOR_MUST_BE_HUMAN`. An `aspirational` objective may skip the sponsor.
3. **NEVER score a `qualitative` KR without an explicit, human-confirmed value + evidence.** Use `cloud okr kr recompute <krId> --value <n> --evidence <ref>` and only with a value the human actually gave you. Metric/task KRs recompute from their real source automatically — don't hand-feed numbers there.
4. **Bind KRs ONLY to today's sources** — task acceptance, IMMetricEvent metric binding, or human-confirm. Do **NOT** invent token/spend/credit targets, CRM pipelines, or analytics metrics — those data sources do not exist (FROZEN). A KR whose evidence you can't name is not a KR; ask the human how it will be measured.
5. **Do NOT create unscoped strategic tasks.** Tactical work for an objective is an existing task **linked to a KR** via `cloud okr link`. If strategic work has no task yet, draft the objective/KR first, then create the task (via the `tasks` skill) and link it.

## Lifecycle back-half

After an objective is committed it runs through `committed → graded → archived`:

- **Check-ins** — you (an agent) MAY draft a check-in. It snapshots the score + each KR's current/status. `cloud okr objective checkin <objectiveId> [--note "<t>"] [--confidence 0.6] [--decision continue|rescope|add-resource|pause|cancel]`.
- **Grade and archive are HUMAN decisions.** `cloud okr objective grade <id>` and `cloud okr objective archive <id>` return `AGENT_CANNOT_GRADE` (403) for an agent caller — surface the objective and ask the human to grade. Grade freezes the score (it stops moving even if a KR's evidence changes). An archived objective is read-only.

Check-in `--decision`, `--confidence`, and the reward/resource shapes carry **no token/credit meaning** — there is no compensation here.

## FROZEN / out of scope

This skill draws ONE Objective + its KRs and links tasks. It does **NOT** propose, create, or mutate any of the following — they are explicitly out of scope for release203 and have no endpoints here:

- **Guardrails** — no guardrail proposals or activations.
- **Resource / budget allocation** — no credit/budget/resource grants.
- **Scenario packs** — none.
- **Proactive / recurring check-ins** — you record a check-in only when asked; there is no auto-scheduler.
- **Compensation** — no reward/bonus economics (the grade carries no payout).

If the user asks for any of these, say it's not part of the OKR charter flow yet rather than improvising one.

## CLI Reference

### Objectives

```bash
# Draft (agent proposes — NOT committed)
cloud okr objective create --workspace <id> --title "<outcome>" \
  [--type committed|aspirational] [--narrative "<DoD>"] [--cycle 2026-Q3] \
  [--owner <imUserId>] [--sponsor <human imUserId>] [--parent <objectiveId>] [--confidence 0.7]

cloud okr objective list --workspace <id> [--state <state>]
cloud okr objective get <objectiveId>

# HUMAN/SPONSOR ONLY — an agent caller gets AGENT_CANNOT_COMMIT
cloud okr objective commit <objectiveId>
cloud okr objective close <objectiveId> [--score 0.8]
```

### Key Results

```bash
cloud okr kr add <objectiveId> --title "<measurable result>" \
  [--type metric|task|milestone|qualitative] \
  [--baseline <n>] [--target <n>] [--unit <u>] \
  [--direction increase|decrease|maintain|binary] [--weight <n>] \
  [--metric-namespace <ns> --metric-name <name> --metric-agg avg|sum|last|count] \
  [--evidence "<policy>"] [--source assigned|agent-proposed]

# Qualitative KR scoring — human-confirmed value + evidence ONLY
cloud okr kr recompute <keyResultId> [--value <n>] [--evidence <ref>]
```

> `--source` defaults to `agent-proposed` (you, the agent, are drafting). Pass `--source assigned` only when the human explicitly assigned the KR.
> `--metric-namespace` and `--metric-name` must be given together to bind a metric source.

### Linking + reading

```bash
cloud okr link <objectiveId> <keyResultId> <taskId>   # scope a task to a KR
cloud okr insights --workspace <id>                    # the OKR tree + KR progress (never fabricated)
```

## Output reporting

After any state-changing command, **echo back** the id and the **state the service returned** (not the state you expected). Example:

> Drafted objective `cmobj...` (state `draft`) with 3 KRs. @<sponsor> — `cloud okr objective commit cmobj...` to commit.

If a command exits non-zero, surface the error code verbatim — especially `AGENT_CANNOT_COMMIT` / `SPONSOR_MUST_BE_HUMAN`, which mean a human must act. **Never fabricate an objective/KR id or a KR value** — if you didn't run the command or it failed, say so.
