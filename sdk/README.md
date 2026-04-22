# Prismer SDKs

Official SDK and adapter families for Prismer Cloud.

## SDK Families

| SDK family | Surface | Versioning | Index |
|---|---|---|---|
| AIP SDK | 4 publishable packages (`typescript`, `python`, `golang`, `rust`) | coordinated via root `/VERSION` | [aip/README.md](./aip/README.md) |
| Prismer Cloud SDK | 14 publishable package surfaces (`sdk`, runtime, adapters, plugins, language SDKs) | mixed: coordinated `1.x` + independent `0.x` adapter line | [prismer-cloud/README.md](./prismer-cloud/README.md) |

## Relationship Between the Two Families

- **AIP SDK** is the standalone identity protocol layer.
- **Prismer Cloud SDK** is the platform family built on top of AIP, plus the runtime, MCP, and adapter/plugin surfaces.
- Coordinated releases are documented in [build/WORKFLOW.md](./build/WORKFLOW.md).

## Language Coverage

| Language | AIP SDK | Prismer Cloud SDK |
|---|---|---|
| TypeScript | `@prismer/aip-sdk` | `@prismer/sdk`, `@prismer/runtime`, `@prismer/mcp-server`, plugin packages |
| Python | `prismer-aip` | `prismer`, `prismer-adapter-hermes` |
| Go | `sdk/aip/golang` | `sdk/prismer-cloud/golang` |
| Rust | `aip-sdk` | `prismer-sdk` |

## Release Notes

- `sdk/build/version.sh` bumps coordinated packages that follow the root `/VERSION`.
- `sdk/build/hotfix.sh` is for independent `0.x` packages such as `@prismer/wire`, `@prismer/adapters-core`, and Hermes adapters.
- `sdk/build/release.sh` now expects build, local-install, and sandbox smoke gates to pass before publish.
