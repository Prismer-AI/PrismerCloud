// WS-B (PP-1) — minimal type shim for Paseo's provider-snapshot-manager.
//
// structured-generation-providers references ProviderSnapshotManager only as a
// type (Pick<…, "listProviders">). The full snapshot manager (provider catalog
// warm-up + cwd-scoped snapshots) is not needed for the PURE PORT; the concrete
// implementation is a B2 concern. Only the consumed surface is declared.
//
// See docs/release203/08-paseo-port-unified-agent-engine.md §7.7 WS-B.
import type { ProviderSnapshotEntry } from "./agent-sdk-types.js";

export interface ProviderSnapshotReadOptions {
  cwd?: string;
  providers?: string[];
  wait?: boolean;
}

export interface ProviderSnapshotManager {
  listProviders(input?: ProviderSnapshotReadOptions): Promise<ProviderSnapshotEntry[]>;
}
