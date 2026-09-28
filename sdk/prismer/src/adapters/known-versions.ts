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
// `'unknown'` plus a TODO. We will not pretend to have pinned what we
// have not actually tested. Range probes retain that bootstrap soft-pass;
// exact binary pins use the strict `checkBinaryPin` path instead.
//
// release203/08 B3 (2026-06-18): the ported Paseo engine live-verified the
// code-agent stack end-to-end through OUR gateway (10/10). The three coding
// providers below are now pinned to the exact versions B3 exercised:
//   claude-code → @anthropic-ai/claude-agent-sdk 0.2.141 (control protocol)
//   codex       → codex 0.137 binary (app-server protocol coupling)
//   opencode    → opencode 1.14.46 binary (== @opencode-ai/sdk lock)
// hermes stays unpinned (honesty rule) — no concrete CI rev exercised yet.
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
  /**
   * release203/06 §3.1a (doc 03 §3.2 known-config-keys) — the upstream env var
   * names the adapter MUST use to point the CLI at our gateway. Pinned here so a
   * regression to a wrong/legacy name (e.g. CC's G4 bug: writing the legacy
   * `ANTHROPIC_API_BASE` instead of the CLI-read `ANTHROPIC_BASE_URL`) is caught
   * by the env-key contract test instead of silently dead-overriding.
   *
   *   envKey  — base-URL override env var the CLI actually reads
   *   authKey — Bearer-token env var the CLI actually reads
   */
  envKey?: string;
  authKey?: string;
  /**
   * D1 (apc M2-1, docs/apc/05 §1.D) — exact CLI BINARY
   * pin enforced on the spawn path (`checkBinaryPin`, mismatch = explicit
   * `AdapterBinaryPinError`, escape hatch `PRISMER_ALLOW_UNPINNED=1`).
   * Distinct from `minVersion`/`knownGood`, which for claude-code track the
   * @anthropic-ai/claude-agent-sdk control protocol, not the binary.
   */
  binaryPin?: string;
}

export const ADAPTER_KNOWN_VERSIONS: Record<string, AdapterKnownVersion> = {
  // Hermes — TS adapter currently has no spec on a minimum upstream
  // version; the `hermes -p <name> gateway run` autospawn surface is
  // stable across the 1.x line, but we have not yet pinned a CI rev.
  // TODO(v2.0.8): pin after cookbook real-runs against a concrete
  // hermes release.
  // Hermes is the long-horizon agent (system core), kept first-class.
  // release203/08 WS-C: hermes already emits rich events through the
  // unified recorder (its recordToolCall/setPhase carry altitude='milestone').
  // The `hermes -p <name> gateway run` autospawn surface is stable across
  // the 1.x line but we still have not pinned a concrete CI rev.
  // TODO(v2.0.8): pin after cookbook run exercises a concrete hermes binary.
  hermes: {
    minVersion: '0.0.0',
    knownGood: 'unknown',
    note: 'release203/08 WS-C: on unified recorder (altitude=milestone). TODO(v2.0.8): pin after cookbook run exercises real hermes binary',
  },
  // Codex — the ported Paseo engine drives codex via its app-server
  // protocol (CodexAppServerAgentClient), which couples to the codex
  // BINARY version (thread / turn / item.* events, `responses` wire
  // payload). release203/08 B3 (2026-06-18) live-ran codex 0.137 end-to-end
  // through OUR gateway (DeepSeek source): turn complete + interrupt +
  // file-rewind-rejected. Pinned to the binary B3 actually exercised.
  // The legacy CLI adapter (`codex exec --cd`) survives as the `codex-cli`
  // D21 fallback; the engine takes the canonical `codex` name.
  codex: {
    minVersion: '0.137.0',
    knownGood: '0.137.0',
    note: 'release203/08 B3 live-ran codex 0.137 app-server e2e via gateway (DeepSeek source); binary version couples the app-server protocol — keep in sync with image-pin.yaml binaries.codex',
  },
  // Claude Code — the ported Paseo engine drives claude via
  // `@anthropic-ai/claude-agent-sdk` (ClaudeAgentClient: query() streaming +
  // interrupt/setModel/rewind). release203/08 B3 (2026-06-18) live-ran the
  // claude stack end-to-end through OUR gateway (model=kimi on the Anthropic
  // wire, ANTHROPIC_BASE_URL + AUTH_TOKEN injected, no official key): 5/5 —
  // file write + structured tool detail + interrupt + setModel.
  // knownGood pins the claude-agent-sdk the engine speaks (control protocol);
  // the `claude` CLI binary baked into the image is tracked in
  // image-pin.yaml binaries.claude (2.1.179). The legacy CLI adapter survives
  // as the `claude-code-cli` D21 fallback; the engine takes `claude-code`.
  'claude-code': {
    minVersion: '0.2.141',
    knownGood: '0.2.141',
    note: 'release203/08 B3 live-ran @anthropic-ai/claude-agent-sdk 0.2.141 (the installed/resolved version) e2e via gateway (5/5). minVersion/knownGood track the claude-agent-sdk control protocol, not the CLI binary (image-pin.yaml binaries.claude tracks the 2.1.179 CLI).',
    // release203/06 §3.1a — CC reads ANTHROPIC_BASE_URL (NOT the legacy
    // ANTHROPIC_API_BASE) for the gateway base, and ANTHROPIC_AUTH_TOKEN (NOT
    // ANTHROPIC_API_KEY) for the sk-prismer-* Bearer. Pinned to lock the G4 fix.
    envKey: 'ANTHROPIC_BASE_URL',
    authKey: 'ANTHROPIC_AUTH_TOKEN',
    // apc M2-a: FALLBACK mirror of the SSOT `image-pin.yaml binaries.claude.version`.
    // The spawn path reads image-pin.yaml directly (apc-pinned-binary.ts
    // resolveClaudeBinaryPin); this literal is only consulted when infra/ is
    // off-disk (packaged / pod runtime). A drift-guard test
    // (claude-code-pin-and-isolation.test.ts) keeps it byte-equal to the SSOT.
    binaryPin: '2.1.179',
  },
  // OpenCode — NEW provider added by the ported Paseo engine
  // (OpenCodeAgentClient: spawns `opencode serve`, HTTP client +
  // session.subscribe streaming). The app-server JSON protocol is
  // version-LOCKED to `@opencode-ai/sdk`, so the binary and the SDK pin
  // must match exactly. release203/08 B3 (2026-06-18) live-ran opencode
  // 1.14.46 end-to-end through OUR gateway: custom-provider opencode.json +
  // listCommands + turn output (2/2). Pinned to the binary B3 exercised;
  // keep in sync with image-pin.yaml binaries.opencode + @opencode-ai/sdk.
  opencode: {
    minVersion: '1.14.46',
    knownGood: '1.14.46',
    note: 'release203/08 B3 live-ran opencode 1.14.46 e2e via gateway (2/2); app-server protocol version-locked to @opencode-ai/sdk — pin binary == sdk.',
  },
};
