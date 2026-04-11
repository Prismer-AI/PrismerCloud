# Changelog

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
