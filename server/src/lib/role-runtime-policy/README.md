# role-runtime-policy

Canonical runtime policy and prompt-contract module for role / skill
standardization.

## Ownership

This folder owns the reusable runtime contract for role-aware agents:

- authority scopes and memory policy
- MCP allowlist projection
- live prompt builders
- legacy prompt injection for snapshotted rows
- workspace bootstrap prompt / role-template snapshots

If a caller needs one of those shapes, it should ask this module instead of
handwriting strings or tool lists inline.

## Files

- `policy.ts`:
  canonical authority, memory, and MCP projection policy.
- `prompt-contract.ts`:
  CEO / specialist prompt builders and built-in role prompt seeds.
- `workspace-contract.ts`:
  simple-mode workspace prompt, kickoff message, and role-template snapshot
  builders.
- `injection.ts`:
  idempotent legacy prompt patch helpers for existing rows / snapshots.
- `index.ts`:
  public re-export surface for callers.

## Invariants

- `RoleRuntimePolicy` is the source of truth for authority and memory rules.
- `projectMcpAllowlist()` is the only supported way to derive MCP tools from
  policy.
- Do not handwrite these strings in callers:
  `prismer.skill.installed`, `office-artifacts`, `Chief of Staff`,
  `task.approve/reject/cancel`, `maxAutonomousRounds`.
- Prompt text belongs here, not in UI or service call sites.
- `sdk/prismer-cloud/runtime/src/templates/roles/ceo.json` and
  `src/im/sql/425_v201_ceo_role_bundle.sql` are snapshots. Keep them aligned,
  but do not treat them as canonical sources.

## Main consumers

- `src/im/acp/profile-defaults.ts`
- `src/im/api/agent-profiles.ts`
- `src/im/services/agent-spec.service.ts`
- `src/app/workspace/lib/templates.ts`
- `src/app/workspace/components/unified-creation/use-simple-provisioning.ts`

## Extension workflow

1. Add or update the canonical builder here first.
2. Update callers to consume the builder.
3. Update snapshot files or parity tests if a persisted prompt changes.
4. Keep `README.md` and the tests in sync with any new exported surface.

## Notes

- The module is intentionally small and boring.
- New role prompt variants should live here, not as ad hoc string literals in
  feature code.
- If a prompt needs to be persisted, treat the persisted row as a snapshot of
  this module, not the source of truth.
