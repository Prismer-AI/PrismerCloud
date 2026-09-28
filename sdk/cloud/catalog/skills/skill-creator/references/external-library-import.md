# External skill-library import

Use this workflow when the source is a repository or directory containing more
than one skill, especially when the result will be wired into a role.

## 1. Establish the authoritative source

- Read the repository README, license, and AGENTS.md before changing anything.
- Identify mirrors/translations and import only the source tree the repository
  declares authoritative. Record the excluded mirrors in the final report.
- Inventory directories containing a root `SKILL.md`; do not infer the count
  from repository file totals.
- Work from a temporary copy when normalization is genuinely required. Do not
  edit the cloned authority merely to satisfy the platform parser.

The Prismer bundle parser accepts ordinary YAML block scalars (`description: |`
and `description: >`). The description quality floor is language-aware, so a
concise CJK description need not be padded with filler. If validation rejects
either shape, treat it as a CLI/runtime version-skew problem before rewriting
the source.

## 2. Run the deterministic import harness

After choosing the authoritative tree, put configuration in the runtime
environment and run one command:

```bash
node scripts/import-library.mjs --json
```

Required environment: `PRISMER_SKILL_LIBRARY_ROOT`. Optional:
`PRISMER_SKILL_LIBRARY_EXCLUDE` (comma/newline-separated relative trees),
`PRISMER_IMPORT_LEDGER`, `PRISMER_CLOUD_BIN`, `PRISMER_CLOUD_BASE`, and
`PRISMER_ALLOW_REMOTE_WRITE=1` for an explicitly confirmed non-local target.
Authentication remains in the Cloud CLI's injected environment/config; never
put a token in arguments or source files.

Use `--preflight-only` when only inventory/validation is requested. The harness:

1. discovers root `SKILL.md` bundles under the selected tree;
2. validates the entire set locally before the first create;
3. rejects duplicate requested slugs, which usually means both an authority and
   its mirror were selected;
4. creates only unverified ledger rows and persists every server-returned slug;
5. verifies private content through owner-scoped `cloud skill show --content`;
6. emits `requiredSkills[]` from verified canonical slugs for `role-builder`.

Do not publish the first item as an exploratory probe. A probe creates durable
catalog state and is not a substitute for a read-only validator.

If `cloud` exists but a documented command such as `skill create` is absent,
report the installed CLI version and use the repository's current Cloud CLI
build. Do not silently jump to a raw HTTP request or a bundled ingest script;
that bypasses the exact auth/scope/readback path being verified. The portable
script is only a fallback when the CLI binary itself is unavailable.

## 3. Recovery and lower-level diagnosis

On a transient failure, rerun the same command with the same
`PRISMER_IMPORT_LEDGER`; verified rows are not recreated. If the selected files
changed, the harness rejects the stale ledger before Cloud calls—use a new
task-bound ledger after reviewing that change.

Only diagnose a failed row with the lower-level primitives:

```bash
cloud skill validate <dir> --json
cloud skill create <dir> --json
cloud skill mine --json
cloud skill show <returned-slug-or-id> --content --json
```

Community slugs may be prefixed by the server; never lowercase, prefix, or
otherwise reconstruct them. A conflict alone is not proof of a complete or
correct prior import.

## 4. Verify the private domain correctly

`cloud skill find` searches the public Marketplace and is expected not to show
workspace-private skills. Verify authored skills through:

```bash
cloud skill mine --json
cloud skill show <canonical-slug-or-id> --content --json
```

Every successful ledger row must round-trip. Do not create temporary catalog
objects to discover response shape; use `--json` on the real create/readback.

## 5. Hand canonical slugs to role-builder

Generate `requiredSkills[]` only from successful ledger rows. Then use the
`role-builder` workflow:

```bash
cloud role validate <role-dir> --json
cloud role test <role-dir> --json
cloud role create <role-dir> --json
cloud role show <returned-slug-or-id> --json
```

`role test` is the read-only dependency proof. Do not apply the role merely to
test resolution. Applying changes a live agent profile and requires the user's
explicit target and intent; never use the currently executing agent as a probe.

## Completion evidence

Report selected/excluded source trees, validated/created/failed counts, the
canonical slug ledger, role readback, and whether any apply was explicitly
requested. A POST count or a list of requested names is not completion evidence.
