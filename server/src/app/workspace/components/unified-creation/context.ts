'use client';

/**
 * Shared types + context hooks for the UnifiedCreationModal sub-tree.
 *
 * Extracted into its own file so child step components (SimpleStep2Team,
 * ProModeFlow, ...) can `import` the type / hooks without going through the
 * parent `./UnifiedCreationModal` module — which would create a circular
 * dependency (parent imports child, child imports parent).
 *
 * UnifiedCreationModal re-exports these names so existing call sites keep
 * working without changes.
 */

import { createContext, useContext } from 'react';

// ───────────────────────── UnifiedCreationEvent ─────────────────
//
// Discriminated union per B0 audit (docs/54release/30-b0-dialog-audit.md).
// Parents demux by `kind`. Used both by the modal and by child flows that
// reference the event type (e.g. ProModeFlow when forwarding the callback).

export type UnifiedCreationEvent =
  | { kind: 'workspace'; id: string }
  | { kind: 'device'; id: string }
  | { kind: 'agent'; ids: string[] }
  | { kind: 'conversation'; id: string }
  | { kind: 'task'; id: string }
  | {
      kind: 'simple-team';
      agentIds: string[];
      conversationId: string;
      organizationName?: string;
      /** Task 42 — IDs of materials uploaded during the new "upload" step (empty when user skipped). */
      uploadedAssetIds?: string[];
    };

// ───────────────────────── React contexts ───────────────────────
//
// Two pieces of shared state plumbed down to nested creation steps:
//   - workspaceId — Step 2 device picker needs it for the API probe.
//   - deviceSelector callback — Step 2 device click bubbles up to update
//     capacity in the parent modal.
//
// Both contexts are created here so the modal's Providers and the child
// hooks (`useWorkspaceId`, `useDeviceSelector`) reference a single canonical
// React context instance — splitting the providers across two files would
// create two separate contexts whose values would never align.

/** Provides workspaceId to nested creation steps (Simple mode Step 2 device picker). */
export const WsCtx = createContext<string>('');

/** Provides device-selection callback to nested creation steps. */
export const DeviceSelCtx = createContext<(deviceId: string, daemonId: string, maxAgents: number) => void>(() => {});

/** Returns the current workspaceId from the nearest UnifiedCreationModal ancestor. */
export function useWorkspaceId(): string {
  return useContext(WsCtx);
}

/** Returns a callback to select a device and update capacity state in the creation modal. */
export function useDeviceSelector(): (deviceId: string, daemonId: string, maxAgents: number) => void {
  return useContext(DeviceSelCtx);
}
