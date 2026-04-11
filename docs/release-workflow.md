# PrismerCloud SDK — Build & Release Workflow

Complete reference for maintaining, testing, and releasing all SDK packages.

---

## Quick Reference

| Command | Purpose |
|---------|---------|
| `build/sync.sh` | Sync `sdk/` from source development repo |
| `build/test.sh` | Run all tests against production |
| `build/verify.sh` | Pre-release verification |
| `build/pack.sh` | Package all artifacts |
| `build/release.sh` | Full release orchestration |
| `build/version.sh X.Y.Z` | Bump version across all packages |

All scripts support `--dry-run` to preview without executing.

---

## Package Registry Map

| # | Package | Registry | Install |
|---|---------|----------|---------|
| 1 | `@prismer/sdk` | npm | `npm i @prismer/sdk` |
| 2 | `prismer` | PyPI | `pip install prismer` |
| 3 | Go SDK | Go Proxy (git tag) | `go get github.com/Prismer-AI/PrismerCloud/sdk/prismer-cloud/golang` |
| 4 | `prismer-sdk` | crates.io | `cargo add prismer-sdk` |
| 5 | `@prismer/mcp-server` | npm | `npx -y @prismer/mcp-server` |
| 6 | `@prismer/opencode-plugin` | npm | `npm i @prismer/opencode-plugin` |
| 7 | `@prismer/claude-code-plugin` | npm | `npm i @prismer/claude-code-plugin` |
| 8 | `@prismer/openclaw-channel` | npm | `openclaw plugins install @prismer/openclaw-channel` |

---

## Development → Release Pipeline

```
prismer-cloud-next/sdk/    (source of truth — active development)
        │
        ▼  build/sync.sh
PrismerCloud/sdk/          (release repo — open source)
        │
        ▼  build/test.sh
    All tests pass (production base URL)
        │
        ▼  build/verify.sh
    Version consistency + build + artifacts OK
        │
        ▼  build/pack.sh
    build/artifacts/{npm,pypi,crates}/
        │
        ▼  build/release.sh
    GitHub Release + npm + PyPI + crates.io + Go tag
```

---

## Sync from Source

```bash
# Full clean sync (delete + re-copy)
build/sync.sh

# Incremental sync (no delete)
build/sync.sh --no-clean

# Preview only
build/sync.sh --dry-run
```

Source: `/Users/prismer/workspace/prismer-cloud-next/sdk/`
Target: `/Users/prismer/workspace/PrismerCloud/sdk/`

Excludes: `node_modules`, `.venv`, `dist`, `target`, `build`, `*.egg-info`, `__pycache__`, `*.tgz`, `package-lock.json`, `.next`, `.pytest_cache`

---

## Testing

```bash
# Run all tests against production
build/test.sh

# Run single SDK tests
build/test.sh --only ts
build/test.sh --only python
build/test.sh --only go
build/test.sh --only rust

# Skip specific tests
build/test.sh --skip openclaw

# Include integration tests (requires PRISMER_API_KEY)
build/test.sh --include-integration
```

All tests run against `PRISMER_BASE_URL=https://prismer.cloud`.

### Test Matrix

| Package | Runner | Type |
|---------|--------|------|
| TypeScript SDK | vitest | Unit + integration |
| Python SDK | pytest | Unit + integration |
| Go SDK | go test | Unit + integration |
| Rust SDK | cargo test | Unit + doc-tests |
| MCP Server | npm run build | Build verification |
| OpenCode Plugin | npm run build | Build verification |
| Claude Code Plugin | JSON validation | Config validation |
| OpenClaw Channel | tsc --noEmit | Type check |

---

## Pre-Release Verification

```bash
# Full verification (build + test + version check)
build/verify.sh

# Skip tests (if just ran them)
build/verify.sh --skip-tests

# Skip builds (if just built)
build/verify.sh --skip-build

# Verify specific version
build/verify.sh --version 1.8.0
```

### Verification Phases

1. **Version Consistency** — All 17 version files match
2. **Package Manifests** — publishConfig, repository URLs, Go module path
3. **Build Verification** — All packages compile, expected artifacts exist
4. **Test Verification** — All tests pass
5. **Publish Readiness** — npm auth, cargo token, gh auth (warnings)

---

## Packaging

```bash
# Package everything
build/pack.sh

# Clean previous artifacts first
build/pack.sh --clean

# Package single SDK
build/pack.sh --only typescript
```

### Artifact Output

```
build/artifacts/
├── npm/
│   ├── prismer-sdk-{VER}.tgz
│   ├── prismer-mcp-server-{VER}.tgz
│   ├── prismer-opencode-plugin-{VER}.tgz
│   ├── prismer-claude-code-plugin-{VER}.tgz
│   └── prismer-openclaw-channel-{VER}.tgz
├── pypi/
│   ├── prismer-{VER}-py3-none-any.whl
│   └── prismer-{VER}.tar.gz
└── crates/
    └── prismer-sdk-{VER}.crate
```

---

## Releasing

```bash
# Full release (interactive, with confirmation prompts)
build/release.sh

# Auto-confirm all prompts
build/release.sh --yes

# Dry run (preview all steps)
build/release.sh --dry-run

# Release to specific registry only
build/release.sh --npm-only
build/release.sh --pypi-only
build/release.sh --github-only
build/release.sh --crates-only

# Skip verification (if already verified)
build/release.sh --skip-verify
```

### Release Steps

1. Pre-flight display
2. `build/verify.sh` (version + builds)
3. `build/pack.sh --clean` (create artifacts)
4. Git tag `v{VERSION}` + `sdk/golang/v{VERSION}`, push to origin
5. `gh release create` with all artifacts attached
6. `npm publish` x 5 packages
7. `twine upload` to PyPI
8. `cargo publish` to crates.io

### Required Credentials

| Registry | Credential |
|----------|-----------|
| npm | `npm login` or `NPM_TOKEN` in `.npmrc` |
| PyPI | `twine` config or `TWINE_USERNAME`/`TWINE_PASSWORD` |
| crates.io | `CARGO_REGISTRY_TOKEN` env var |
| GitHub | `gh auth login` |
| Go Proxy | Automatic (git tag push triggers) |

---

## Version Bumping

```bash
# Explicit version
build/version.sh 1.8.0

# Semver bumps
build/version.sh --patch   # 1.7.3 → 1.7.4
build/version.sh --minor   # 1.7.3 → 1.8.0
build/version.sh --major   # 1.7.3 → 2.0.0

# Preview changes
build/version.sh --dry-run 1.8.0
```

### Version File Map (17 files)

| File | Pattern |
|------|---------|
| `sdk/typescript/package.json` | `"version": "X.Y.Z"` |
| `sdk/mcp/package.json` | `"version": "X.Y.Z"` |
| `sdk/opencode-plugin/package.json` | `"version": "X.Y.Z"` |
| `sdk/claude-code-plugin/package.json` | `"version": "X.Y.Z"` |
| `sdk/claude-code-plugin/.claude-plugin/plugin.json` | `"version": "X.Y.Z"` |
| `sdk/openclaw-channel/package.json` | `"version": "X.Y.Z"` |
| `sdk/python/pyproject.toml` | `version = "X.Y.Z"` |
| `sdk/rust/Cargo.toml` | `version = "X.Y.Z"` |
| `sdk/python/prismer/__init__.py` | `__version__ = "X.Y.Z"` |
| `sdk/rust/src/cli.rs` | `version = "X.Y.Z"` |
| `sdk/mcp/src/index.ts` | `version: 'X.Y.Z'` |
| `sdk/rust/Cargo.lock` | Regenerated via `cargo update` |
| `sdk/README.md` | Header version references |
| `sdk/typescript/README.md` | Header version |
| `sdk/python/README.md` | Header version |
| `sdk/golang/README.md` | Header version |
| `sdk/rust/README.md` | Header + install snippet |

---

## Recurring Release Cycle

For each new version:

```bash
# 1. Bump version in source repo (prismer-cloud-next)
#    ... develop, test locally ...

# 2. Sync to release repo
build/sync.sh

# 3. Bump version (if not already bumped in source)
build/version.sh X.Y.Z

# 4. Test against production
build/test.sh

# 5. Verify everything
build/verify.sh --skip-tests

# 6. Package
build/pack.sh --clean

# 7. Commit and release
git add -A && git commit -m "Release vX.Y.Z"
build/release.sh --version X.Y.Z
```

---

## Troubleshooting

### npm publish fails with 403
- Ensure `npm login` was done for the `@prismer` scope
- Check `publishConfig.access` is `"public"` in package.json

### Go module not found after release
- Go proxy may take a few minutes to index
- Verify tag format: `sdk/golang/vX.Y.Z`
- Verify go.mod module path matches repo structure

### Python twine upload fails
- Check `~/.pypirc` or set `TWINE_USERNAME`/`TWINE_PASSWORD`
- Run `twine check dist/*` before uploading

### Cargo publish fails
- Set `CARGO_REGISTRY_TOKEN` env var
- Run `cargo package --allow-dirty` to verify packaging first

### Version mismatch detected
- Run `build/version.sh --dry-run X.Y.Z` to see which files need updating
- Check `sdk/mcp/src/index.ts` and `sdk/rust/src/cli.rs` (hardcoded versions)
