# Diagnosing delegation concurrency and total budgets

Use this as a maintainer diagnostic, not permission to spawn more workers or
edit a tenant's Runtime configuration. First identify the deployed Hermes
version and exact resolved settings. Defaults below describe the audited source
1a1f4a59e252e1dc0137e7b2e7bcc8b0381d19c4, not every installation.

## Distinct constraints

- delegation.max_concurrent_children: default 10 in tools/delegate_tool_config.py.
  Configuration/env overrides and a floor of 1 apply.
- A batch larger than the allowed concurrent children can be rejected.
- Multiple delegate_task calls in one turn can be truncated by the parent.
- One-shot execution also has a TOTAL subagent budget (default 2 in the audited
  code). A later call can exhaust that budget despite free concurrent slots.
- Nesting depth, leaf role, approval, provider failures and tool availability
  can prevent delegation independently of these counts.
- A high-cost warning above 10 is emitted once; it is not itself a throttle.

## Diagnostic sequence

1. Read the task's actual model tool calls, returned errors and parent/child
   lifecycle records. Redact prompts, credentials and tenant data.
2. Inspect effective config using the deployed version's read-only config
   command; do not assume a value typed in a source file was loaded.
3. Compare batch length, current active workers, total children already spawned,
   one-shot mode/budget, nesting role/depth and approvals.
4. Trace tools/delegate_tool_config.py, tools/delegate_tool.py and the parent
   call limiter in the exact deployed checkout if necessary.
5. Search bounded logs for rejection/truncation AND one-shot budget errors.
   Absence of a log line does not prove absence of a limiter or prove model
   self-restraint; logging may differ by version or context.
6. Only attribute model-side under-dispatch when the actual emitted tool call
   requests fewer tasks and the other constraints are verified, not from prose.

## Running the requested work

Use the exposed delegate_task tool directly when available and within all
budgets. It is not in the audited execute_code web/file/terminal allowlist;
never attempt to route it through code execution to evade a limit.
Queue bounded batches or perform lenses sequentially when workers are limited.
Do not increase concurrency, disable approval or change model automatically.

Concurrency is per-parent in the inspected code; account/provider/host-wide
limits can still apply. A background child is not evidence of a durable task.
If durable execution is required, use Prismer's task ownership and scheduler
contract, not a second Hermes control plane.
