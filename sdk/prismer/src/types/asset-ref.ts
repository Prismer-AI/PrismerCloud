// MIRROR of `src/im/types/asset-ref.ts` (cloud-side source of truth).
// Runtime is standalone, so this leaf wire type is mirrored without importing Cloud source.
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
