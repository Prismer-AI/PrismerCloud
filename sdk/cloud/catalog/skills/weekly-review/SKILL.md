---
name: weekly-review
scope: common
category: productivity
description: Review commitments and stalled work from Prismer tasks and memory, then produce an evidence-based weekly plan with explicit coverage gaps.
license: MIT
metadata:
  nativeReplaces: [weekly-review-planning]
  upstream: Hermes Agent skills/productivity/weekly-review-planning at 1a1f4a59e2
---
# Weekly Review

Resolve review period and timezone from the request/context. Use tasks, memory,
and okr only where available and authorized. External calendars and inboxes are
optional sources, never assumed capabilities.

1. Read completed and active tasks, relevant decisions, goals and waiting items.
2. Record outcomes, owner, deadline, blocker, last activity and source link.
   Silence is not evidence of completion.
3. Identify overdue work, missing next actions, duplicates and conflicting states.
4. Review next week's capacity only from available calendar/user evidence.
   Without it, state that capacity is unverified instead of inventing free hours.
5. Propose a small set of outcomes ranked by deadline, consequence and dependency.
   Name deferred work and evidence gaps.
6. Apply updates already authorized by the user, then read back changed records.
   Draft follow-up messages unless sending them was requested.
7. Report wins, risks, waiting items, next-week outcomes, verified updates and gaps.

Do not create cron jobs or a recurring monitor merely because this skill ran.
Scheduling is a separate explicit request handled through platform scheduling.

## Coverage and planning detail

Declare the authoritative system when stores disagree. Inspect both the completed
week and the next 1-2 weeks for travel, preparation, deadlines and commitments.
Classify each capture item as next action, project, waiting, scheduled, someday,
reference, archive proposal or delete proposal; count unprocessed items. Consult
`prismer-email-inbox-triage` for thread-level email handling only when authorized.

For every waiting item identify who owes what, its supporting record/event/thread
and a proposed review or follow-up date. Keep proposed dates separate from agreed
deadlines. For every active project identify an outcome and next action or mark
it paused/unresolved. Rank outcomes by consequence, deadline, dependency and effort;
reserve slack rather than allocating all apparent free hours. Explicitly name
deferred work. Return wins, overdue/at-risk work, waiting items, stalled projects,
next-week outcomes/calendar constraints, proposed updates and coverage gaps.

Calendar holds, rescheduling, archive/delete and messages each need authorization
covering that effect. A request to run a review alone is not a scheduling request.
