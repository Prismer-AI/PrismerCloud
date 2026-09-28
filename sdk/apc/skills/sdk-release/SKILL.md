---
name: sdk-release
description: SDK build, test, version bump, and release to open source repo + registries. Covers the full pipeline from development in prismer-cloud-next to publishing on npm/PyPI/crates.io/Go.
allowed-tools: Bash, Read, Write, Edit
---

# SDK Release Workflow

## Architecture

```
prismer-cloud-next/sdk/          ← Source of truth (active development)
├── prismer-cloud/               ← Main SDK suite (8 packages)
│   ├── typescript/              @prismer/sdk
│   ├── python/                  prismer (PyPI)
│   ├── golang/                  prismer-sdk-go
│   ├── rust/                    prismer-sdk (crates.io)
│   ├── mcp/                     @prismer/mcp-server
│   ├── claude-code-plugin/      @prismer/claude-code-plugin
│   ├── opencode-plugin/         @prismer/opencode-plugin
│   └── openclaw-channel/        @prismer/openclaw-channel
│
├── aip/                         ← AIP identity suite (4 packages)
│   ├── typescript/              @prismer/aip-sdk
│   ├── python/                  prismer-aip
│   ├── golang/                  prismer-aip-go
│   └── rust/                    prismer-aip
│
└── build/                       ← Build scripts (NOT in open source)
    ├── sync.sh                  Whole-directory sync to PrismerCloud
    ├── test.sh                  Run all tests against production
    ├── verify.sh                Pre-release checks
    ├── pack.sh                  Create publishable artifacts
    ├── version.sh               Bump version across all packages
    └── release.sh               Orchestrate full release

        │
        ▼  sync.sh (rsync --delete)

PrismerCloud/                    ← Open source repo (github.com/Prismer-AI/PrismerCloud)
├── sdk/                         ← EXACT mirror, no residual files
│   ├── prismer-cloud/           (flattened or nested — matches source)
│   ├── aip/
│   └── ...
├── build/                       ← Release tooling (stays in open source)
│   ├── pack.sh
│   ├── release.sh
│   └── ...
└── docs/
```

## Key Principle: WHOLE-DIRECTORY REPLACE, NOT COPY

The sync step uses `rsync --delete` to ensure the open source repo is an **exact mirror** of the source. This prevents residual files from deleted features, renamed packages, or restructured directories from lingering in the open source repo.

```bash
# This is correct — --delete removes files not in source
rsync -av --delete --exclude='...' source/sdk/ target/sdk/

# This is WRONG — leaves deleted files behind
cp -r source/sdk/* target/sdk/
```

## Pipeline

### Step 1: Develop in prismer-cloud-next

All development happens in prismer-cloud-next/sdk/. This includes:

- Code changes
- New packages
- Directory restructuring
- Version bumps
- Build verification
- Local testing

### Step 2: Build & Test (in prismer-cloud-next)

```bash
# Build all packages
cd sdk/prismer-cloud/typescript && npm run build
cd sdk/prismer-cloud/mcp && npm run build
cd sdk/prismer-cloud/opencode-plugin && npm run build
cd sdk/prismer-cloud/python && pip install -e ".[dev]" && pytest
cd sdk/prismer-cloud/golang && go build ./... && go test ./...
cd sdk/prismer-cloud/rust && cargo build

# Build AIP packages
cd sdk/aip/typescript && npm run build
cd sdk/aip/python && pip install -e ".[dev]" && pytest
cd sdk/aip/golang && go build ./...
cd sdk/aip/rust && cargo build

# Integration tests against production
npx tsx scripts/test-all-apis.ts --env prod
```

### Step 3: Version Bump (in prismer-cloud-next)

```bash
# Bump all packages to target version
# This updates all version files listed in the Version File Map
sdk/build/version.sh 1.7.4

# Or use semver shortcuts
sdk/build/version.sh --patch   # 1.7.3 → 1.7.4
sdk/build/version.sh --minor   # 1.7.3 → 1.8.0
```

#### Version File Map

**prismer-cloud suite:**
| File | Pattern |
|------|---------|
| `sdk/prismer-cloud/typescript/package.json` | `"version": "X.Y.Z"` |
| `sdk/prismer-cloud/mcp/package.json` | `"version": "X.Y.Z"` |
| `sdk/prismer-cloud/mcp/src/index.ts` | `version: 'X.Y.Z'` |
| `sdk/prismer-cloud/opencode-plugin/package.json` | `"version": "X.Y.Z"` |
| `sdk/prismer-cloud/claude-code-plugin/package.json` | `"version": "X.Y.Z"` |
| `sdk/prismer-cloud/claude-code-plugin/.claude-plugin/plugin.json` | `"version": "X.Y.Z"` |
| `sdk/prismer-cloud/openclaw-channel/package.json` | `"version": "X.Y.Z"` |
| `sdk/prismer-cloud/python/pyproject.toml` | `version = "X.Y.Z"` |
| `sdk/prismer-cloud/python/prismer/__init__.py` | `__version__ = "X.Y.Z"` |
| `sdk/prismer-cloud/rust/Cargo.toml` | `version = "X.Y.Z"` |
| `sdk/prismer-cloud/golang/README.md` | version reference |

**aip suite:**
| File | Pattern |
|------|---------|
| `sdk/aip/typescript/package.json` | `"version": "X.Y.Z"` |
| `sdk/aip/python/pyproject.toml` | `version = "X.Y.Z"` |
| `sdk/aip/golang/go.mod` | module path |
| `sdk/aip/rust/Cargo.toml` | `version = "X.Y.Z"` |

### Step 4: Sync to Open Source (WHOLE-DIRECTORY REPLACE)

```bash
sdk/build/sync.sh
```

This does:

1. `rm -rf PrismerCloud/sdk/` (clean slate)
2. `rsync -av --delete --exclude={node_modules,dist,target,...} sdk/ PrismerCloud/sdk/`
3. Verify file count and structure

**CRITICAL:** This is a whole-directory replace. Any files that existed in PrismerCloud/sdk/ but not in prismer-cloud-next/sdk/ will be deleted. This is intentional — it prevents residual files from accumulating.

### Step 5: Pack & Release (in PrismerCloud)

```bash
cd /Users/prismer/workspace/PrismerCloud

# Verify everything
build/verify.sh

# Package artifacts
build/pack.sh --clean

# Release to all registries
build/release.sh --version 1.7.4
```

This publishes to:

- **npm:** @prismer/sdk, @prismer/mcp-server, @prismer/opencode-plugin, @prismer/claude-code-plugin, @prismer/openclaw-channel
- **PyPI:** prismer
- **crates.io:** prismer-sdk
- **Go Proxy:** triggered by git tag `sdk/golang/vX.Y.Z`
- **GitHub Release:** with all artifacts attached

## Quick Reference

| What         | Where              | Command                      |
| ------------ | ------------------ | ---------------------------- |
| Develop      | prismer-cloud-next | (normal development)         |
| Build        | prismer-cloud-next | `sdk/build/test.sh`          |
| Version bump | prismer-cloud-next | `sdk/build/version.sh X.Y.Z` |
| Sync         | prismer-cloud-next | `sdk/build/sync.sh`          |
| Verify       | PrismerCloud       | `build/verify.sh`            |
| Pack         | PrismerCloud       | `build/pack.sh --clean`      |
| Release      | PrismerCloud       | `build/release.sh`           |

## What NOT to Do

- **Do NOT edit code in PrismerCloud/sdk/** — it will be overwritten on next sync
- **Do NOT copy files instead of rsync --delete** — residual files will accumulate
- **Do NOT publish from prismer-cloud-next** — always sync to PrismerCloud first
- **Do NOT skip version bump** — version mismatches break verify.sh
- **Do NOT publish without verify.sh passing** — it catches version mismatches, missing builds, and auth issues

## Registries & Credentials

| Registry  | Credential                                       | Check                |
| --------- | ------------------------------------------------ | -------------------- |
| npm       | `npm login --scope=@prismer`                     | `npm whoami`         |
| PyPI      | `~/.pypirc` or `TWINE_USERNAME`/`TWINE_PASSWORD` | `twine check dist/*` |
| crates.io | `CARGO_REGISTRY_TOKEN`                           | `cargo login`        |
| GitHub    | `gh auth login`                                  | `gh auth status`     |
| Go Proxy  | Automatic (git tag push)                         | —                    |
