// Origin Adapter SPI — pluggable producers of asset bytes.
//
// Doc 26 §4 Phase 2 splits asset producers behind a uniform contract:
//   - upload      — Web `POST /api/im/assets` (cloud-side, wrapped by C4)
//   - drop-folder — daemon watches `~/.prismer/workspaces/<wid>/drop/`
//   - agent-gen   — daemon-local RPC `POST /local/asset/write` (Hermes / CC etc.)
//
// The three steps are decomposed so the outbox + uploader can drive any
// adapter without knowing its mechanism:
//   1. observe()        → stream of SourceObservation
//   2. identifySource() → canonical sourceRef (no bytes read yet)
//   3. fetch()          → bytes + mime + size, only when actually uploading
//
// Keeping identifySource separate from fetch lets us deduplicate via
// idempotencyKey before paying the read cost — relevant when the same file
// gets re-detected by a flapping fs.watch.

export type OriginKind = 'upload' | 'drop-folder' | 'agent-gen';

export interface SourceObservation {
  /** Workspace this observation belongs to. */
  workspaceId: string;
  /** Adapter-specific opaque payload; the same adapter that emitted it can re-fetch from it. */
  detail: Record<string, unknown>;
  /**
   * Source-side observation timestamp (file mtime, RPC arrival, etc.). Used
   * by the outbox idempotency key so a re-observation of an unmodified
   * source collapses to one row.
   */
  observedAt: number;
}

export interface SourceIdentity {
  /**
   * Stable canonical identifier for the producing source. Examples:
   *   - drop-folder: `folder://<watchId>/<relpath>`
   *   - agent-gen:   `agent://<sourceAgentImUserId>/<filename>`
   *   - upload:      `upload://<workspaceId>/<contentHash>`
   *
   * Cloud-side stored as `IMAsset.sourceRef`; combined with workspaceId it
   * is the dedup boundary for "same source observed twice".
   */
  sourceRef: string;
  /** Optional metadata that should travel with the eventual upload. */
  hints?: SourceHints;
}

export interface SourceHints {
  filename?: string;
  folderPath?: string;
  description?: string;
  /** When agent-gen wrote it, which agent imUserId is the producer. */
  sourceAgentImUserId?: string;
}

export interface SourceBytes {
  bytes: Buffer;
  mime: string | null;
  size: number;
}

export interface OriginAdapter {
  readonly kind: OriginKind;
  /**
   * Long-lived async iterable of observations from this adapter for one
   * workspace. drop-folder yields whenever fs.watch reports a new file;
   * agent-gen yields whenever the local RPC accepts a write; upload (cloud)
   * yields nothing locally — it lives on the cloud side.
   */
  observe(workspaceId: string): AsyncIterable<SourceObservation>;
  /** Compute the canonical sourceRef + hints from an observation, without reading bytes. */
  identifySource(obs: SourceObservation): Promise<SourceIdentity>;
  /** Read the bytes for an observation. May be expensive (fs read or buffer copy). */
  fetch(obs: SourceObservation): Promise<SourceBytes>;
}
