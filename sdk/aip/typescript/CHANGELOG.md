# Changelog

## Unreleased

- `HermesBundleConfig` 新增可选 `modelContextLengths?: Record<string, number>`
  （runtime-bootstrap protocol 字段三包同步：prismer/cloud/aip；additive，
  向后兼容）。AIP 不消费该字段——仅保持 bundle 类型同构。

- Aligned package metadata with monorepo version `2.2.40` for the immutable
  sandbox/runtime release coordinate; no npm publication is implied.
- Aligned package metadata with monorepo version `2.2.39` for the immutable
  sandbox/runtime release coordinate; no npm publication is implied.

- Memory authority snapshot types (product209/16 MA-1B, Task 10):
  `RuntimeConfigBundle` gains the optional `memoryAuthority` field
  (`MemoryAuthoritySnapshotBundleV1`) — mirror kept in sync with
  @prismer/runtime and @prismer/sdk. The bundle `signature` field remains
  P3-reserved.

- The monorepo pack pipeline now materializes this package first and installs
  that exact tarball into the Cloud SDK before producing Runtime OTA bundles.
- ConfigDelivery P1: RuntimeConfigBundle protocol types synced for AIP identity
  consumers. Design: docs/product209/07-config-delivery-runtime-bootstrap.md §3.3.

## 2.2.5 (2026-08-02)

- Reaffirmed AIP as an independently published open identity and trust protocol,
  separate from Cloud orchestration and Runtime lifecycle concerns.
- Added shared TypeScript/Python conformance vectors and packaged CLI coverage so
  both implementations enforce the same signing and verification contract.
- Declared public npm publishing metadata and aligned the release version with
  the monorepo `/VERSION` source of truth.

## 2.0.0 (2026-05-19)

- Coordinated v2.0.0 GA release for the Prismer Cloud SDK suite. `/VERSION`
  (single source of truth) → 2.0.0; AIP TS SDK version-bumped in lockstep
  via `sdk/build/version.sh`.
- **No AIP API changes this cycle** — built-in identity APIs unchanged
  (`AIPIdentity.create`, `sign`, `verify`, DID:KEY, VC, delegation).
- `@prismer/sdk` 2.0.0 now pins `@prismer/aip-sdk@^2.0.0`; both packages
  must be upgraded together.

## 1.8.1 (2026-04-10)
- Version bump to align with `@prismer/sdk` 1.8.1 (which now pins this package via semver, replacing the prior `file:` path that broke fresh installs).
- Built-in identity APIs unchanged (`AIPIdentity.create`, `sign`, `verify`, DID:KEY, VC, delegation).

## 1.8.0 (2026-04-09)
- Version alignment with Prismer Cloud v1.8.0
- No API changes from 1.7.3

## 1.7.3 (2025-12-01)
- Initial public release
- DID:KEY identity (Ed25519)
- DID Document generation
- Delegation chain support
- Verifiable Credentials (VC) issuance and verification
- Verifiable Presentations (VP)
- Bitstring revocation
- CLI tools
