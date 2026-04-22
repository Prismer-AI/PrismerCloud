## v1.9.0 (2026-04-22)

Version bump to 1.9.0 coordinated release. No API changes. Drop-in upgrade.
- Go modules: use `github.com/Prismer-AI/PrismerCloud/sdk/prismer-cloud/golang@v1.9.0`

---

## Unreleased

---

## v1.8.2 (2026-04-13)

### Added — **Task type extensions**
- Task struct: `Progress`, `StatusMessage`, `ConversationID`, `CompletedAt`, `OwnerID`, `OwnerType`, `OwnerName`, `AssigneeType`, `AssigneeName`
- `ApproveTask()`, `RejectTask()`, `CancelTask()` client methods
- `TaskStatus` now includes `"review"` state

---

## v1.8.1 (2026-04-10)

### Fixed — **Module path**
- Previous `v1.8.0` tag was published before the `go.mod` path was corrected to `github.com/Prismer-AI/PrismerCloud/sdk/prismer-cloud/golang` — users running `go get github.com/Prismer-AI/PrismerCloud/sdk/prismer-cloud/golang@v1.8.0` hit `module declares its path as: github.com/Prismer-AI/PrismerCloud/sdk/golang`. v1.8.1 tag includes the corrected go.mod.
- No API changes; drop-in upgrade from 1.8.0.

---

## v1.8.0 (2026-04-04)

### Added
- `GetWorkspace(scope, slots, includeContent)`: Fetch workspace superset view with slot filtering
- `InstallSkill(slugOrID, scope)`: Scope parameter for scoped skill installation

## v1.7.4 (2026-04-01)

### Added
- AIP identity: `Identity().BuildDID`, `Identity().ResolveDID`, `Identity().Delegate`, `Identity().Revoke`
- Verifiable Credentials: `Credentials().Issue`, `Credentials().Verify`, `Credentials().Present`
- **Parity tests**: 30 cross-language integration tests (P1-P12)

### Changed
- Leaderboard Phase 2: reimplemented server-side with improvement-based ranking
# prismer-sdk-go -- Changelog

## v1.7.3 (2026-03-27)

### Added
- Data Governance: qualityScore wired into gene lifecycle and skill operations
- Doc samples test suite (`doc_samples_test.go`) -- 21 tested code samples
- LICENSE file (MIT)
- CHANGELOG.md

## v1.7.2 (2026-03-15)

### Added
- **Tasks API**: `Tasks().Create`, `Tasks().Get`, `Tasks().List`, `Tasks().Claim`, `Tasks().Complete`, `Tasks().Fail`
- **Memory API**: `Memory().CreateFile`, `Memory().GetFile`, `Memory().UpdateFile`, `Memory().DeleteFile`, `Memory().ListFiles`, `Memory().Load`, `Memory().Compact`
- **Identity API**: `Identity().RegisterKey`, `Identity().GetKey`, `Identity().RotateKey`, `Identity().RevokeKey`
- **EvolutionRuntime**: High-level `Suggest()` / `Learned()` / `GetMetrics()` with Thompson Sampling cache
- **Skills API**: `SearchSkills`, `InstallSkill`, `UninstallSkill`, `InstalledSkills`, `GetSkillContent`

## v1.7.1 (2026-02-20)

### Added
- **Evolution API**: `Analyze`, `Record`, `Evolve`, `CreateGene`, `ListGenes`, `DeleteGene`, `PublishGene`, `BrowseGenes`
- **Sync API**: `Sync`, `SyncStream` (SSE)
- **Files API**: `Presign`, `Confirm`, `Quota`, `UploadFile`

## v1.7.0 (2026-02-10)

### Added
- Initial release with Context, Parse, and IM APIs
- CLI binary (`prismer` command)
- Webhook handler with HMAC-SHA256 verification
- Real-time WebSocket and SSE clients
