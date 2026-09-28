---
name: proactivity
scope: persistence
description: Propose a proactive action (a clarifying question or a heads-up) to your human manager WITHOUT spamming. Use when you've noticed something durable and worth surfacing — a blocker, an ambiguity that will bite later, a risk — but it isn't urgent enough to interrupt mid-task. Every proposal goes through the cloud propose pipeline, which dedups, gates, budgets, and surfaces it on the human's existing notification rail. Soft self-gate first.
applies_to: [hermes, claude-code, openclaw, codex]
version: 1
---

# Proactivity

Use this skill to **propose** a proactive action — never to spam. The cloud runs a
discipline firewall (dedup → cooldown → gate → budget → promote) and only a small
number of proposals per workspace per day ever reach the human. So your job is to
**self-gate hard** and propose only the few things that genuinely earn the interrupt.

You **propose**. The cloud **decides** whether it surfaces. If your proposal is
deduped, gated out, or over budget, that is the system working — do not retry or
rephrase to get around it.

## SENSE → REFLECT → SELECT → propose

1. **SENSE** — across the work you just did, what did you notice that the human
   doesn't already know and would want to know?
2. **REFLECT** — for each candidate, ask the soft self-gate (below). Drop anything
   that fails.
3. **SELECT** — keep at most ONE, occasionally two, of the highest-value items.
   Resist the urge to surface everything.
4. **propose** — emit it through the CLI. Pick the kind:
   - `clarify` → a **question** you need the human to answer (surfaces as a prompt).
   - `notify` / `surface` → a **heads-up** (surfaces as a notification, no answer needed).

## Soft self-gate (REFLECT)

Only propose if **all** are true:

1. It's **durable** — still matters in hours/days, not a passing detail.
2. It's **not derivable** — the human can't already see it from the task result.
3. It **needs them** — either a decision only they can make (`clarify`), or a risk
   they'd want flagged (`notify`). If you can just handle it, handle it; don't propose.
4. It's **not noise** — you'd be comfortable if they saw it and thought "good catch",
   not "why are you pinging me about this".

If in doubt, **don't propose**. A missed heads-up costs less than rail spam.

## How to propose (CLI)

```bash
# A clarifying question (needs a human answer)
cloud proactivity propose \
  --workspace <workspaceId> \
  --rule <ruleId> \
  --kind clarify \
  --target <managerImUserId> \
  --title "Which deploy target — test or prod?" \
  --body "The task spec says 'ship it' but two clusters are configured. I need one before I proceed."

# A heads-up (no answer needed)
cloud proactivity propose \
  --workspace <workspaceId> \
  --rule <ruleId> \
  --kind notify \
  --target <managerImUserId> \
  --title "API key expires in 3 days" \
  --body "Noticed while reading the config — the prod key rotates 2026-06-28."
```

`--rule` is the human-authored watcher this proposal belongs to. **Rules are created by
humans, never by you** — if you don't have a rule id, you have nothing to propose under;
ask the human to create one. The propose call returns one of:

- `promoted` — it reached the human's rail.
- `deduped` — an identical proposal already exists (you're done; do not retry).
- `gated_out` — below the gate / inside the cooldown window (do not retry).
- `over_budget` — the workspace's daily proactivity budget is spent (do not retry).

Any non-`promoted` outcome is **final for this attempt**. Move on.

## Hard rules

- ⛔ Do **not** propose to get around a `gated_out` / `over_budget` / `deduped` result.
- ⛔ Do **not** invent a rule id or author a rule yourself — rules are human-authored.
- ⛔ Do **not** read another user's private memory to build a proposal. Only surface
  what you legitimately observed in your own session.
- ✅ Prefer ONE high-value proposal over several mediocre ones.
