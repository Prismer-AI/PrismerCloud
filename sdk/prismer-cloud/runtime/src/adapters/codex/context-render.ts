// release201/25 §7 / release201/26 §7.4 — Codex (CLI) envelope renderer.
//
// Codex is a SPAWN-style interactive adapter — the daemon runs the
// `codex` CLI with a single composed prompt string (no structured API
// surface for history). Same constraints as claude-code: STATELESS from
// our perspective, markdown formatting beats XML for CLI agents (no
// schema doc layer to teach the parser).
//
// This adapter delegates to the claude-code renderer because both CLI
// adapters need the exact same markdown body shape — keeping the
// rendering in one place prevents drift. The re-export exists so the
// daemon dispatch path can do `import { renderContextEnvelope } from
// '../codex/context-render.js'` symmetrically with hermes/openclaw,
// even though under the hood the implementation is shared.
//
// If a future codex-specific shape lands (e.g. native multimodal that
// requires a different asset reference syntax) we replace the re-export
// with a dedicated implementation here.

export type {
  CliRenderedContext,
  CliRenderOptions,
} from '../claude-code/context-render.js';
export { renderContextEnvelope } from '../claude-code/context-render.js';
