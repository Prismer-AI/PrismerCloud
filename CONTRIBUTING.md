# Contributing to PrismerCloud

Thanks for your interest in contributing! Whether it's a bug fix, new feature, documentation improvement, or SDK enhancement — all contributions are welcome.

## Getting Started

### Prerequisites

- Node.js 20+
- Docker & Docker Compose (for MySQL)
- Git

### Local Development

```bash
git clone https://github.com/Prismer-AI/PrismerCloud.git
cd PrismerCloud
cp .env.example .env
npm install
npm run prisma:generate

# Start MySQL
docker compose up mysql -d

# Start dev server
npm run dev
```

Open [localhost:3000](http://localhost:3000).

### IM Server (standalone)

For working on the IM/messaging layer without the full app:

```bash
mkdir -p prisma/data
DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx prisma db push
DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npm run im:dev
```

## How to Contribute

### Report a Bug

Open an [issue](https://github.com/Prismer-AI/PrismerCloud/issues/new?labels=bug) with:
- Steps to reproduce
- Expected vs actual behavior
- Environment (OS, Node version, Docker version)

### Suggest a Feature

Open an [issue](https://github.com/Prismer-AI/PrismerCloud/issues/new?labels=enhancement) describing:
- The problem you're trying to solve
- Your proposed solution
- Alternatives you've considered

### Submit a Pull Request

1. Fork the repo and create your branch from `main`
2. Make your changes
3. Run quality checks:
   ```bash
   npm run check    # ESLint + TypeScript
   npm run format   # Prettier
   ```
4. If you've added API endpoints, update `docs/API.md`
5. Commit with [conventional commits](https://www.conventionalcommits.org/):
   ```
   feat: add webhook retry logic
   fix: handle empty response in context load
   docs: update self-host guide for ARM64
   ```
6. Open a PR against `main`

### Work on an Existing Issue

Look for issues labeled [`good first issue`](https://github.com/Prismer-AI/PrismerCloud/labels/good%20first%20issue) — these are scoped, well-defined tasks ideal for first-time contributors.

## Project Structure

```
src/
├── app/           # Next.js pages and API routes
├── components/    # React components
├── contexts/      # React context providers
├── im/            # IM server (Hono, embedded)
├── lib/           # Core services and utilities
└── types/         # Shared TypeScript types
sdk/
├── typescript/    # @prismer/sdk (npm)
├── python/        # prismer (PyPI)
├── golang/        # Go SDK
├── rust/          # Rust SDK
└── mcp/           # MCP Server (23 tools)
```

## SDKs

Each SDK lives in `sdk/` and can be developed independently:

| SDK | Dev | Test |
|-----|-----|------|
| TypeScript | `cd sdk/typescript && npm run build` | `npm test` |
| Python | `cd sdk/python && pip install -e ".[dev]"` | `pytest` |
| Go | `cd sdk/golang && go build ./...` | `go test ./...` |
| Rust | `cd sdk/rust && cargo build` | `cargo test` |
| MCP | `cd sdk/mcp && npm run build` | `npx @modelcontextprotocol/inspector node dist/index.js` |

## Code Style

- TypeScript strict mode
- Prettier for formatting
- ESLint for linting
- Run `npm run check` before committing

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
