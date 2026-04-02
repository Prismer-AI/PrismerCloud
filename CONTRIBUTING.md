# Contributing to Prismer Cloud

Thanks for your interest in contributing! This guide will help you get started.

## Repository Structure

```
PrismerCloud/
├── sdk/              ← SDK source (synced from closed-source repo — DO NOT edit directly)
├── docs/             ← Documentation & cookbooks
├── server/           ← Self-host server (Docker)
├── .test/            ← Cookbook integration tests
└── .github/          ← CI workflows
```

> **Important:** The `sdk/` directory is synced from the closed-source `prismer-cloud-next` repository.
> Any SDK changes must be made in that repo first, then synced via `sdk/build/sync.sh`.
> Direct edits to `sdk/` will be overwritten on the next sync.

## What You Can Contribute

| Area | Where | Editable here? |
|------|-------|---------------|
| Documentation & cookbooks | `docs/` | Yes |
| Cookbook integration tests | `.test/` | Yes |
| Root README / translations | `docs/*/README.md` | Yes |
| Server (self-host) | `server/` | Yes |
| SDK source code | `sdk/` | No — use the closed-source repo |
| Seed genes | via `evolve_create_gene` API | Yes |

## Getting Started

### 1. Prerequisites

- Node.js >= 18
- A Prismer API key (`prismer setup` or [prismer.cloud](https://prismer.cloud))

### 2. Run the Cookbook Tests

```bash
cd .test
npm install
PRISMER_API_KEY_TEST="sk-prismer-..." npm test
```

### 3. Run SDK Build Verification

```bash
sdk/build/verify.sh --scope all
```

## Pull Request Guidelines

1. **Branch from `main`** — keep commits focused and atomic
2. **Run tests** — ensure `npm test` passes in `.test/` before submitting
3. **Update docs** — if your change affects documented behavior, update the relevant cookbook or README
4. **Version consistency** — if bumping versions, update all packages together (see `sdk/build/version.sh`)

## Code Style

- TypeScript: ESLint with project config (`sdk/typescript/npm run lint`)
- Python: ruff + mypy strict mode, target py3.8
- Go: standard `go fmt` + `go vet`
- Rust: `cargo clippy`

## Ideas for First Contributions

- **Add a seed gene** — teach agents a new error-handling strategy
- **Build an MCP tool** — extend the MCP server
- **Add a language SDK** — Java, Swift, C#
- **Translate docs** — help agents worldwide
- **Improve test coverage** — add cases to `.test/cookbook/`
- **Report bugs** — every issue helps

See [Good First Issues](https://github.com/Prismer-AI/PrismerCloud/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) for tagged starter tasks.

## Questions?

Join our [Discord](https://discord.gg/VP2HQHbHGn) or open an issue.
