// MIRROR of `src/im/types/asset-ref.ts` (cloud-side source of truth).
//
// `@prismer/sdk` is a standalone npm package and is NOT in the main tsconfig
// (CLAUDE.md layer rule), so this leaf wire type is mirrored here without
// importing Cloud source. It is a LEAF on purpose: both `im-events.ts`
// (dispatch payloads) and `conversation-envelope.ts` consume it, and keeping
// it dependency-free is what makes the wire type graph acyclic.
//
// KEEP IN SYNC. Same manual-sync banner convention as
// `src/types/im-events.ts` / `src/types/conversation-envelope.ts`.
//
// Source of truth chain:
//   src/im/types/asset-ref.ts  ─▶  sdk/prismer/src/types/asset-ref.ts
//                              ─▶  this file
export interface AssetRef {
  assetId: string;
  contentHash: string;
  mime: string | null;
  sizeBytes: number | null;
  kind: string;
  workspaceId: string;
  role: 'attachment' | 'context';
  cdnUrl?: string;
  filename?: string;
}
