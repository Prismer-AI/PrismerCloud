# SDK Build & Release Workflow

> Source repo: `/Users/prismer/workspace/prismercloud`
> Open-source release mirror: `/Users/prismer/workspace/opensource/PrismerCloud`
> Always run `sdk/build/*.sh` from the source repo. `sync.sh` and `release.sh` must not be run inside the open-source clone.

## Repo Roles

```
prismercloud/sdk/                      source of truth
├── aip/                               AIP SDK family
├── prismer-cloud/                     platform SDK + runtime + adapters
└── build/                             build / verify / pack / release scripts

opensource/PrismerCloud/sdk/           release mirror
├── aip/
├── prismer-cloud/
└── build/
```

- `sdk/build/sync.sh` mirrors the entire `sdk/` tree into the open-source clone with `rsync --delete`.
- `sdk/build/release.sh` is the top-level orchestrator. It verifies, packs, runs install smoke checks, syncs to the open-source clone, then tags and publishes.
- `PRISMERCLOUD_REPO` overrides the default mirror path:

```bash
export PRISMERCLOUD_REPO=/path/to/PrismerCloud
```

## Package Inventory

### AIP family

| Surface | Registry | Version policy |
|---|---|---|
| `sdk/aip/typescript` → `@prismer/aip-sdk` | npm | follows root `/VERSION` |
| `sdk/aip/python` → `prismer-aip` | PyPI | follows root `/VERSION` |
| `sdk/aip/golang` | Go module | git tag driven |
| `sdk/aip/rust` → `aip-sdk` | crates.io | follows root `/VERSION` |

### Prismer Cloud family

Current `sdk/prismer-cloud/` contains 14 publishable package surfaces:

| Surface | Package | Registry | Version policy |
|---|---|---|---|
| `typescript` | `@prismer/sdk` | npm | follows root `/VERSION` |
| `python` | `prismer` | PyPI | follows root `/VERSION` |
| `golang` | `github.com/Prismer-AI/PrismerCloud/sdk/prismer-cloud/golang` | Go module | git tag driven |
| `rust` | `prismer-sdk` | crates.io | follows root `/VERSION` |
| `mcp` | `@prismer/mcp-server` | npm | follows root `/VERSION` |
| `runtime` | `@prismer/runtime` | npm | follows root `/VERSION` |
| `sandbox-runtime` | `@prismer/sandbox-runtime` | npm | follows root `/VERSION` |
| `claude-code-plugin` | `@prismer/claude-code-plugin` | npm | follows root `/VERSION` |
| `opencode-plugin` | `@prismer/opencode-plugin` | npm | follows root `/VERSION` |
| `openclaw-channel` | `@prismer/openclaw-channel` | npm | follows root `/VERSION` |
| `wire` | `@prismer/wire` | npm | independent `0.x` |
| `adapters-core` | `@prismer/adapters-core` | npm | independent `0.x` |
| `adapters/hermes-node` | `@prismer/adapter-hermes` | npm | independent `0.x` |
| `adapters/hermes` | `prismer-adapter-hermes` | PyPI | independent `0.x` |

### Dependency order inside `sdk/prismer-cloud`

```text
@prismer/sandbox-runtime
  -> @prismer/wire
  -> @prismer/adapters-core
  -> @prismer/runtime

@prismer/claude-code-plugin  -> @prismer/adapters-core, @prismer/wire
@prismer/openclaw-channel    -> @prismer/adapters-core, @prismer/wire
@prismer/adapter-hermes      -> peer @prismer/runtime
@prismer/sdk                 -> @prismer/aip-sdk
```

## Script Reality

| Script | What it actually does | Important note |
|---|---|---|
| `test.sh` | build / syntax smoke for SDK packages | not a full `pytest` / `go test` / `cargo test` matrix |
| `verify.sh` | version checks + manifest checks + `test.sh` | this is the pre-release verification entrypoint |
| `pack.sh` | builds tarballs / wheels / crates into `sdk/build/artifacts/` | use `--clean` for release |
| `install-local.sh` | offline install smoke via `public/install.sh --local` | validates the installer path |
| `smoke-test.sh` | Docker-based artifact install/import smoke | validates published-style artifacts in a clean Linux image |
| `sync.sh` | destructive whole-directory mirror into the open-source clone | `--scope` does not narrow the sync surface |
| `release.sh` | verify -> pack -> install-local -> smoke-test -> sync -> tag -> publish | run from source repo only |
| `sync-plugin.sh` | helper that mirrors `claude-code-plugin/` into another tree | not part of the automated release commit/tag/push path |

## Mandatory Gates Before Publish

Release means all of these pass in order:

1. `sdk/build/verify.sh`
2. `sdk/build/pack.sh --clean`
3. `sdk/build/install-local.sh --skip-pack`
4. `sdk/build/smoke-test.sh --skip-pack`
5. `sdk/build/sync.sh`
6. `sdk/build/release.sh`

`test.sh` alone is not enough. It proves the packages build. It does not prove that packed artifacts install cleanly or that the installer path still works.

## Standard Flow

### 1. Bump versions

Coordinated release:

```bash
cd /Users/prismer/workspace/prismercloud
sdk/build/version.sh --scope all 1.9.0
```

Independent-package hotfix:

```bash
cd /Users/prismer/workspace/prismercloud
sdk/build/hotfix.sh @prismer/wire 0.1.1
```

### 2. Verify and pack locally

```bash
cd /Users/prismer/workspace/prismercloud
sdk/build/verify.sh --scope all
sdk/build/pack.sh --scope all --clean
sdk/build/install-local.sh --skip-pack
sdk/build/smoke-test.sh --scope all --skip-pack
```

For an AIP-only release, `install-local.sh` can be skipped because it validates the public Prismer installer path, not the standalone AIP surfaces.

### 3. Release

```bash
cd /Users/prismer/workspace/prismercloud
sdk/build/release.sh --scope all
```

`release.sh` will:

1. Re-run `verify.sh`
2. Re-pack artifacts
3. Run `install-local.sh --skip-pack` when `--scope` includes `prismer-cloud`
4. Run `smoke-test.sh --skip-pack` when `--scope` includes `prismer-cloud`
5. Sync `sdk/` into `$PRISMERCLOUD_REPO`
6. Commit only `sdk/` changes in the open-source clone
7. Tag `vX.Y.Z` and `sdk/prismer-cloud/golang/vX.Y.Z`
8. Create a GitHub release
9. Publish npm / PyPI / crates artifacts

## Release Modes

```bash
# All registries
sdk/build/release.sh --scope all

# npm only
sdk/build/release.sh --scope prismer-cloud --npm-only

# PyPI only
sdk/build/release.sh --scope prismer-cloud --pypi-only

# crates.io only
sdk/build/release.sh --scope prismer-cloud --crates-only

# Git tags + GitHub release only
sdk/build/release.sh --scope all --github-only
```

Notes:

- `--scope` affects verify / pack / smoke steps.
- `sync.sh` still mirrors the full `sdk/` tree.
- `--skip-pack`, `--skip-install-local`, and `--skip-smoke` are escape hatches. Do not use them for a normal release.

## Credentials

Keep registry credentials in the open-source clone or export them as environment variables before release:

| Credential | Expected location | Used by |
|---|---|---|
| npm token | `$PRISMERCLOUD_REPO/.npmrc` | `npm publish` |
| PyPI config | `$PRISMERCLOUD_REPO/.pypirc` or `TWINE_*` env | `twine upload` |
| crates token | `$PRISMERCLOUD_REPO/.cargo-credentials` or `CARGO_REGISTRY_TOKEN` | `cargo publish` |
| GitHub auth | `gh auth login` | git tags + GitHub release |

`release.sh` now fails early if the required credentials are missing for the selected publish targets.

## Artifacts

`pack.sh --clean` writes to:

```text
sdk/build/artifacts/
├── npm/*.tgz
├── pypi/*.whl
├── pypi/*.tar.gz
└── crates/*.crate
```

Required local-install smoke artifacts:

- `prismer-aip-sdk-*.tgz`
- `prismer-sdk-*.tgz`
- `prismer-runtime-*.tgz`
- `prismer-sandbox-runtime-*.tgz`
- `prismer-wire-*.tgz`
- `prismer-adapters-core-*.tgz`
- `prismer-mcp-server-*.tgz`

## Sharp Edges

- Do not run `sync.sh` or `release.sh` from inside `/Users/prismer/workspace/opensource/PrismerCloud`.
- `sync.sh` is destructive. It deletes the target `sdk/` tree before mirroring.
- `release.sh` stages only `sdk/` in the open-source repo; unrelated root files are intentionally left alone.
- `test.sh` is a build smoke gate, not a product regression suite. If the release also changes repo-level runtime or API behavior, run the broader repo tests separately.
- `sync-plugin.sh` is not the main release path. Treat it as a follow-up helper, not as proof that a standalone plugin repo has been published.
