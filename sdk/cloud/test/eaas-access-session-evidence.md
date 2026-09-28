# EaaS SDK/CLI verification - 2026-09-24

Scope: incremental changes in the shared working tree; no commit, rollback, spec edits, registry publication, or deployment. Pre-existing changes are retained.

## Changed Files In This Pass

- `src/cli.ts`: EaaS-only API-key/base-URL environment configuration with legacy configuration fallback.
- `src/commands/environment.ts`: context and project-key access-session issue/list/revoke; explicit token display.
- `src/index.ts`, `src/environment-contract.ts`: optional cursor input and backward-compatible nextCursor result.
- `python/prismer/client.py`: sync/async cursor forwarding, existing dictionary envelope retained.
- `test/commands-environment.test.ts`, `tests/unit/environment-client.test.ts`, `python/unit_tests/test_environment_client.py`: command, credential selection and pagination regression tests.
- `scripts/verify-installed-environment.mjs`: reproducible installed-package HTTP contract runner.
- `test/eaas-access-session-evidence.md`: this evidence record.
- Repository `docs/api/environment-service.md`, `docs/openapi.yaml`, `src/app/docs/_cookbook/{en,zh}/environment-service.md`: cursor contract, CLI examples, default create, optional context, deployment/package boundaries and provider capability caveats.

## Evidence

- RED: TypeScript/CLI 3 failed, 73 passed: cursor absent and context/access-session commands unknown. Python 2 failed, 71 passed: sync and async reject cursor. A subsequent credential-selection test failed when context used the IM factory.
- Installed old CLI RED: with only PRISMER_API_KEY/base URL and an empty PRISMER_HOME, context exited 1 with "No credentials" before sending HTTP.
- GREEN: `npx vitest run test/commands-environment.test.ts tests/unit/environment-client.test.ts tests/unit/environment-contract.test.ts`: 91 passed.
- Python `unit_tests`: 80 passed; existing 104 Pydantic deprecation warnings.
- Initial Cloud full package suite: 853 passed, 1 failed, 2 skipped. The skill-ingest failure is resolved by the follow-up below; latest suite: 854 passed, 2 skipped, all 52 files passed.
- `npm run build`: JS and declarations passed. Installed declaration snippet compiled with TypeScript `--strict`, including old `{sessions: []}` assignment and new cursor methods.
- Fresh npm tarball and Python wheel installed under `/tmp/eaas-sdk-owner-3XYjfI`. Registry dependency resolution failed because available `prismer-aip` is at most 1.9.0, while Cloud requires >=2.2.63. Built and installed local AIP 2.2.63 wheel without editing AIP source.
- Installed runner passed: TS, Python sync, Python async, actual cloud executable; 32 HTTP requests to a loopback contract fixture; each client consumed 101 unique sessions across three pages. Default create body was `{}`, project-key Authorization and issuance idempotency were asserted, secrets hidden unless explicitly requested, context and revoke exercised. No source imports substitute for installed packages.
- OpenAPI parsed; cursor/nextCursor present. Both cookbook frontmatter sets, endpoint references, CLI examples, pagination and create-before-context ordering checked. Scoped `git diff --check` passed.

Re-run installed verification:

```sh
node sdk/cloud/scripts/verify-installed-environment.mjs /tmp/eaas-sdk-owner-3XYjfI/npm /tmp/eaas-sdk-owner-3XYjfI/venv/bin/python
```

Logs/artifacts: `/tmp/eaas-sdk-owner-3XYjfI/{build.log,ts-tests.log,targeted-tests.log,python-tests.log,installed-evidence.json,prismer-sdk-2.2.63.tgz,prismer-2.2.63-py3-none-any.whl}`.

## Seven-Dimension Impact

| Dimension | Impact and remaining verification |
| --- | --- |
| UI/UX | Bilingual tutorial and CLI output only; no Dashboard changes. Docs browser navigation/build not run here. |
| Server/data | No server/schema edits in this pass. Pagination ordering, isolation and revoke side effects require server-owner tests. |
| Endpoint | Documented limit/cursor and sessions/nextCursor; project-key commands use the existing endpoints. Legacy calls retained. |
| Runtime/SDK/cache | TS/Python/CLI changed and installed artifacts verified. No cache or offline success introduced. Runtime execution not exercised. |
| Skills/roles | No role, prompt, skill or catalog behavior changed. Follow-up repaired the stale skill-ingest test entrypoint and fixture; full package suite passes. |
| Desktop | N/A for UI/IPC/native changes: only SDK and docs touched; declarations compile, but no Electron build or live desktop test. |
| EaaS | Direct client contract impact. Publish matching SDK/AIP and deploy matching server before public onboarding. No image, warm pool or bundle protocol changes here; no re-provision action established by this client change. |

These results establish client packaging and HTTP contracts only. Real Cloud/Runtime, provider cleanup, permission intersections, active stream revocation, docs browser navigation, registry install and test/prod deployment remain separate acceptance gates owned by the coordinating agent.

## Skill-Ingest Follow-Up

The missing script was not removed by npm extraneous pruning. Commit `08cba0778621c6d0bb3f102fa932a4f8d55c6a4a` (2026-09-23) deleted `catalog/skills/skill-builder/scripts/ingest.mjs` and added `catalog/skills/skill-creator/references/skill-builder/scripts/ingest.mjs`; HEAD tracks the latter and the catalog has no working-tree changes. The test retained the old path. The current script delegates to `cloud skill create`, rather than implementing its former standalone parser.

Changed `test/skill-ingest-fallback.test.ts` to use the current catalog path and launch this checkout's actual CLI through the existing tsx dependency, with a temporary isolated config and loopback HTTP server. This avoids global CLI installations and stale dist artifacts. The old description fixture also failed current validation (46 quality units; minimum 50); expanded the two-line fixture while retaining exact description/newline assertions. Added endpoint and Authorization assertions. No production validator, catalog, dependency manifest or lockfile was changed.

Verification: reproduced missing-module RED; after path/harness repair reproduced description-validation RED; corrected fixture then targeted GREEN. `npx vitest run` finished with 52 files passed, 854 tests passed, 2 existing skipped, exit 0. Log: `/tmp/eaas-sdk-owner-3XYjfI/ts-tests-after-ingest-fix.log`. Scoped diff check passed. No real-server startup or state was changed.

## Context Capability Follow-Up

Additional authorized scope: `src/tenant/context.ts` and `src/tenant/__tests__/context.test.ts`. Context now reuses projectPoolPolicy and providerCapabilities, exposes only allowed/enabled pools and their enabled placements, follows the project default, and returns null rather than substituting a disabled default. The existing lifecycleActions string array is the intersection of provider support across these placements, gated by environments:write; empty candidates produce no actions. Kind and E2B expose only delete; ACS alone exposes pause/wake/delete. No snapshot/restore/suspend support is claimed. DTO shape is unchanged.

Provider audit: context placements[].providerKind already exists in the TS DTO; Python sync/async context methods return dictionaries and preserve it. Added TS and Python assertions for providerKind and lifecycleActions. Session provider values anonymous/identity/delegated match server and both SDKs. EnvironmentStatus currently does not expose provider in either the server serializer/contract or SDK DTO; no new field was invented.

Verification: eight new context cases initially failed; after implementation they passed. Context/platform-config/provider-capabilities targeted suite: 20 passed. SDK environment client/contract: 66 passed. Python environment client: 73 passed. Root `tsc --noEmit --incremental false`, context ESLint, SDK build and OpenAPI parse passed. Existing deprecation warnings remain. API reference, OpenAPI description and SDK DTO comment document intersection semantics. No live-server or database mutation was performed for this follow-up.

Seven dimensions: UI discovery now reflects allowed provider capabilities; server metadata projection changed without schema/migration; endpoint/SDK shape remains compatible; no Runtime/cache changes; no skill/role changes; no Desktop UI/IPC changes (native validation N/A); EaaS context visibility/actions changed and require the matching server deployment, with no image/bundle or re-provision action. Existing environment authorization remains enforced by operation endpoints.
