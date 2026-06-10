---
name: human-approval
description: Request human approval before performing a SAFETY-CRITICAL, IRREVERSIBLE, or SCOPE-EXPANDING action — submit a structured context (action, scope, risk, consequence) plus options, then STOP the current turn. The platform redispatches the agent after the human decides. NEVER use for routine deliverables (writing docs / generating files / summarising chats / answering questions / explaining concepts / read-only tool calls) — those are pre-authorized; just produce the output. The 5-minute-rollback litmus test applies: if the wrong outcome can be undone in <5 minutes by editing or deleting, it is NOT approval-eligible. Routine misuse (intro/explain/summarise/file-generation) burns the user's attention budget and is a contract violation. Executes via `cloud approval` CLI.
---

# Human Approval

Some actions need a human in the loop **before** they execute: production deploys, large credit spend, deleting data, scope-expanding decisions. This skill submits a structured request and **halts the current turn**. The platform stores the request, notifies the human, and **redispatches the agent** with the decision when the human responds — you don't poll, you don't re-ask in the same turn.

## When to use

- **Production-impacting** action: deploy, schema change, infra reconfig, payment send.
- **Irreversible**: delete files, drop tables, revoke keys, close accounts.
- **Scope-expanding**: the task as-stated implies more changes than the user originally agreed to.
- **High credit cost**: any operation that would spend > expected budget.
- **Authority-elevating**: granting access, changing roles, modifying ACLs.

## Not when to use

- Routine clarifying questions ("what column name do you want?") — just ask in chat.
- Choosing between two equivalent options where the user clearly didn't care — pick one and proceed.
- When the user already explicitly approved this action in the current conversation — proceed.

## Skill scope guard (v2.0.8)

The "Not when to use" list above is the **load-bearing rule**. As of
release 2.0.8 we tightened it because routine deliverables (write a
doc, summarise a chat, draft a slide deck, answer a question) were
incorrectly triggering approval gates — the user got a yellow "等待
人工确认" banner for a request as simple as "@ceo 给我介绍一下产品 PDF",
which is a deliverable request, not a scope-expansion.

The following 8 categories are **never** approval-eligible. Run them
directly and report the result in the same turn:

| Category | Why it's not approval-eligible | Use instead |
|---|---|---|
| Writing a document / generating a report / outputting PDF, DOCX, PPTX, XLSX, CSV | The user *asked for the deliverable*; gating it is anti-UX. | Call `office-artifacts` and ship. |
| Summarising a conversation / writing meeting notes | Pure synthesis from data the user already has. | Reply in chat. |
| Answering a question / explaining a concept | The user invited the answer by asking. | Reply in chat. |
| Asking the user for a preference ("Chinese or English?") | A chat question is the correct affordance. | Ask in chat — `human-approval` is overkill. |
| Choosing model parameters / temperature / sampling style | Internal agent decision; users don't have context to judge. | Decide and proceed; mention the choice in the reply. |
| Naming files / picking output paths | Internal agent decision; reversible by renaming. | Pick sensible defaults; let user override if asked. |
| Internal brainstorming / scoring multiple candidates | The user asked for the *winner*, not the deliberation. | Do the work, surface the winner. |
| Calling read-only MCP tools (search, web fetch, file read) | No side effect; trivially reversible. | Call directly. |

**The litmus test:** "**If this step turns out wrong, can I roll it
back in under 5 minutes by editing or deleting something?**"
  - If **yes** → not approval-eligible. Ship it.
  - If **no** → safety-critical / irreversible / scope-expanding → approval-eligible.

Mis-using `human-approval` for routine work burns the user's attention
budget, breaks chat flow, and signals lack of agent confidence — all
three are real costs. The role templates (CEO / engineer / marketer /
researcher / verifier) carry an explicit `operatingPrinciples` line as
of 2.0.8: "Never trigger human-approval for routine deliverables".

## CLI Reference

**Anchor required.** `POST /api/im/approvals` rejects requests with neither `taskId` nor `conversationId`, because the platform needs a target to deliver the human decision to. Every invocation MUST pass one of `--task-id` or `--conversation-id`.

```bash
# Linked to a task — the platform resumes the task on decision (preferred for marketplace / agent flows)
cloud approval request-human \
  --task-id <taskId> \
  --action "approve marketplace task completion" \
  --context "Result: scan-deps found 3 CVEs. Report attached." \
  --risk "Releases 10-credit escrow to the assignee."

# Linked to a conversation — the decision is posted back as a chat message
cloud approval request-human \
  --conversation-id <conversationId> \
  --action "delete branch feat/old-experiment" \
  --context "Last commit 2025-12-10. Merged into main. Local copy preserved." \
  --risk "Irreversible. No remote backup; force-pushed commits would be lost."

# With explicit options (multi-choice)
cloud approval request-human \
  --conversation-id <conversationId> \
  --action "deploy v1.8.2 to prod" \
  --context "All gates green, 9/9 webhook tests pass, test env stable 48h." \
  --risk "Touches payment webhook. Rollback ETA 5min via git revert + redeploy." \
  --options "deploy-now" "deploy-tomorrow-morning" "wait-for-manual-smoke-test"
```

## Workflow

1. **Summarize the action** in one sentence — what will happen, on what resource, with what permission.
2. **Provide context** — recent state, related artifacts, why this came up now.
3. **Spell out risk and consequence** — what breaks if this is wrong, what's reversible, what's not, who else is affected.
4. **Provide options** when binary approve/reject is insufficient. Options must be **mutually understandable** and **independently actionable** (each is a thing the agent can do without further clarification).
5. **Submit the approval request.** Capture the returned `approvalId`.
6. **Stop the current turn.** Don't ask follow-up questions, don't start the action, don't speculate about the answer. The platform will redispatch you when the human decides.

## Operating Rules

- **Do not proceed with the gated action in the same turn after requesting approval.** This is the load-bearing rule. The platform will redispatch the agent with the decision; running the action now defeats the gate.
- **Do not hide material risks or irreversible effects** from the approval context. The human is approving based on what you wrote — incomplete framing is worse than no gate.
- **Keep options mutually understandable and actionable.** "Approve" / "Approve with conditions" / "Reject" is fine. "Maybe" / "Let me think" is not — that's not a decision the human can choose.
- **Use this for safety-critical decisions**, not routine clarification. Asking the user "what label do you prefer?" via human-approval is overkill and burns their attention budget.
- **Link to a task** (`--task-id`) when the approval gates a task's progression. The platform resumes the task automatically when the human approves.
- If the user already explicitly approved this exact action earlier in the conversation, **skip the gate**. Repeated approval-prompts for the same authorized action feel broken.

## Output reporting

After submitting:

> Submitted approval request `<approvalId>` for "<action>". Stopping this turn. The platform will redispatch when the human decides.

When the agent is redispatched with the decision, the next turn's input includes the approval result. Don't re-issue the request — read the decision and act on it (or report rejection back to the user).

## Backing capabilities (D22 mapping)

Replaces this v1.x built-in skill: `approval-request-human`.
