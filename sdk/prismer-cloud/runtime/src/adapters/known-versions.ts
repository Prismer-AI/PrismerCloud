// Release manifest — adapter-binary versions tested against this runtime
// build (Release 201 v2.0.7 P1).
//
// Governance: every daemon image build cycle should re-validate the four
// upstream binaries below and bump `knownGood` to whatever cookbook +
// CI smoke actually exercised. `minVersion` is the lowest version we
// have ever actively run the adapter wrapper against; below that floor
// the adapter logs a warning at startup.
//
// Honesty rule: when the upstream-version-to-feature mapping is not yet
// validated, leave `minVersion` at `'0.0.0'` and `knownGood` at
// `'unknown'` plus a TODO. The probe will soft-pass; we will not pretend
// to have pinned what we have not actually tested.
//
// Daemon `/healthz` reads this manifest and surfaces both the manifest
// pins and the per-adapter detected version (see
// `LocalServerState.adapters[].knownGood` / `.minVersion`).

export interface AdapterKnownVersion {
  /** Lowest version the wrapper has been actively run against. */
  minVersion: string;
  /** Version exercised by the current cookbook + CI smoke pass. */
  knownGood: string;
  /** Optional human note (why the pin, what to update next). */
  note?: string;
}

export const ADAPTER_KNOWN_VERSIONS: Record<string, AdapterKnownVersion> = {
  // Hermes — TS adapter currently has no spec on a minimum upstream
  // version; the `hermes -p <name> gateway run` autospawn surface is
  // stable across the 1.x line, but we have not yet pinned a CI rev.
  // TODO(v2.0.8): pin after cookbook real-runs against a concrete
  // hermes release.
  hermes: {
    minVersion: '0.0.0',
    knownGood: 'unknown',
    note: 'TODO(v2.0.8): pin after cookbook run exercises real hermes binary',
  },
  // Codex — the adapter relies on `codex exec --cd <cwd>` (see adapter
  // index.ts U2). The `--cd` flag is documented in current CLI ref but
  // the exact introduction version is not in our source tree. We also
  // fall back to spawn `{ cwd }` so older codex still works, only the
  // flag is silently a no-op. Keep unpinned until a cookbook run nails
  // a concrete rev.
  // TODO(v2.0.8): pin after cookbook run against @openai/codex.
  codex: {
    minVersion: '0.0.0',
    knownGood: 'unknown',
    note: 'TODO(v2.0.8): pin after cookbook run against @openai/codex',
  },
  // Claude Code — Wave-4 (2026-05) header in adapter index.ts documents
  // the 2.x flag rename (`--headless` -> `--print`, `--cwd` removed,
  // `--max-turns` dropped from non-interactive mode). 1.x flags would
  // throw `unknown option`, so the wrapper effectively requires 2.x.
  // We pin a conservative 2.0.0 floor; once a CI cookbook run hits a
  // specific 2.x rev we should bump knownGood off `unknown`.
  // TODO(v2.0.8): pin knownGood after cookbook run.
  'claude-code': {
    minVersion: '2.0.0',
    knownGood: 'unknown',
    note: 'Wave-4 flag set requires claude CLI 2.x; pin knownGood after cookbook run',
  },
  // OpenClaw — adapter index.ts line ~244 documents a stderr-bleed bug
  // present in OpenClaw 2026.4.x that the wrapper actively strips. The
  // workaround is version-specific, so the wrapper has only been
  // validated against the 2026.4 line.
  openclaw: {
    minVersion: '2026.4.0',
    knownGood: '2026.4.0',
    note: 'wrapper carries 2026.4.x stderr-bleed workaround; revisit when upstream lands fix',
  },
};
