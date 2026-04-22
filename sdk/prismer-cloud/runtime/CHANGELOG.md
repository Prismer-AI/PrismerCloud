# Prismer Runtime — Changelog

## v1.9.0 (2026-04-21) — T2 daemon lifecycle

### Fixes

- **daemon lifecycle (T2):** `~/.prismer/daemon.port` is now written atomically
  on bind (was only ever promised by README) and removed on clean shutdown.
  File content is `<port>\n` (single line, trailing newline).
- **graceful SIGTERM:** `DaemonProcess` signal handlers now await shutdown then
  `process.exit(0)` — prevents the ~10s SIGKILL fallback that previous
  `daemon stop`/`restart` always printed.
- **daemon status dedup:** `prismer daemon status` is now the low-level local
  probe (PID + port + uptime, no cloud calls). `prismer status` keeps the full
  dashboard. JSON: `{ running, pid, port, uptimeMs }` for daemon-status only.
- **transport status enum:** `/api/v1/transport/status` now distinguishes
  `disabled` / `probing` / `connected` / `unreachable`. `connected` carries
  `path` + `latencyMs`, `unreachable` carries `lastError`. `prismer status`
  surfaces the real diagnosis instead of always printing "disabled".
- **status probes pass bearer:** CLI dashboard now resolves the daemon's API
  key and sends it as `Authorization: Bearer` when probing agents / memory /
  evolution / transport, so authed endpoints stop silently returning null.

## v1.9.0 (2026-04-17)

### Bug Fixes

- **memory.ts:352** - Fixed missing closing braces in command definitions
  - Separated three command definitions (delete/stats/sync) with proper syntax
  - Added missing closing brackets for proper TypeScript structure

- **e2ee-key-storage.ts:25** - Fixed E2EEKeyPair import/export mismatch
  - Changed import from `E2EEKeyPair` to `KeyPair` (correct type from e2ee-crypto.ts)
  - Updated `createKeyEntry` function parameter type accordingly

- **e2ee-key-storage.ts:91** - Fixed Keychain.available() method call
  - Changed `this.keychain.available()` to `await this.keychain.backend().available()`
  - Keychain class requires calling `backend()` method first to get adapter

- **memory.ts:274** - Fixed UI.warning() method not existing
  - Changed `ctx.ui.warning()` to `ctx.ui.info()` (warning method doesn't exist in UI class)
  - Maintains user feedback while using available UI methods

### Impact

- ✅ Resolves all TypeScript compilation errors blocking v1.9.0 release
- ✅ Enables successful build of Runtime package
- ✅ Maintains backward compatibility for memory sync functionality
- ✅ Preserves E2EE key storage functionality with correct type usage

---

## v1.9.0 (Development Notes)

This version includes comprehensive E2EE encryption, Cloud Relay, Memory Gateway, and Task Routing features.
See parent SDK changelog for full feature details.
