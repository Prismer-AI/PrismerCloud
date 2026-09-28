// release202/17 — image-as-reference formatting + vision gating helpers.
//
// Two consumers:
//   1. The cloud-built envelope carries `assets.imageReferences` for recipients
//      it KNOWS are non-vision — these are pixel-free index entries the daemon
//      renders as one-line text tokens.
//   2. DEFENSIVE double-gate: even when the cloud routed images into `inputs`
//      (or `task.assetRefs`), the daemon re-checks the resolved model. If the
//      model is NOT vision-capable, image inputs are degraded to the SAME
//      reference lines instead of being lifted into `image_url` — protecting
//      against a cloud-side gating miss (defence-in-depth, doc 17 §3.3.5).
//
// Single source of the reference-line format so the cloud doc, the envelope
// renderers, and the dispatchers never drift.

import type { ImageReference } from '../../types/conversation-envelope.js';
import type { AssetRef, ResolvedAssetRef } from '../../types/im-events.js';

/**
 * Canonical one-line reference token for a non-vision recipient:
 *   `[image: <filename> · asset <assetId> · <w>×<h>]`
 * Dimensions are omitted when unknown; a caption is appended when present.
 */
export function formatImageReferenceLine(ref: ImageReference): string {
  const parts = [`image: ${ref.filename}`, `asset ${ref.assetId}`];
  if (typeof ref.width === 'number' && typeof ref.height === 'number') {
    parts.push(`${ref.width}×${ref.height}`);
  }
  let line = `[${parts.join(' · ')}]`;
  if (ref.caption && ref.caption.trim().length > 0) {
    line += ` — ${ref.caption.trim()}`;
  }
  return line;
}

/** Project an image AssetRef (no dims available) into an ImageReference. */
export function assetRefToImageReference(ref: AssetRef | ResolvedAssetRef): ImageReference {
  return {
    assetId: ref.assetId,
    filename: ref.filename ?? ref.assetId,
    mime: ref.mime,
    width: null,
    height: null,
    caption: null,
  };
}

/** True when the asset is an image (mime `image/*` or row kind `image`). */
export function isImageAsset(ref: { mime: string | null; kind?: string }): boolean {
  return ref.kind === 'image' || (typeof ref.mime === 'string' && ref.mime.startsWith('image/'));
}

/**
 * Defensive vision gate for a derived multimodal image set.
 *
 * When `supportsVision` is true (or undefined → trust the cloud), the image
 * refs pass through untouched. When it is explicitly `false`, every image ref
 * is degraded to a reference line and removed from the multimodal set.
 *
 * Returns the (possibly emptied) imageRefs plus the degraded reference lines
 * the caller should fold into the text body.
 */
export function gateImageRefsByVision<T extends AssetRef | ResolvedAssetRef>(
  imageRefs: T[],
  supportsVision: boolean | undefined,
): { imageRefs: T[]; degradedLines: string[] } {
  if (supportsVision !== false) return { imageRefs, degradedLines: [] };
  const degradedLines = imageRefs.map((r) => formatImageReferenceLine(assetRefToImageReference(r)));
  return { imageRefs: [], degradedLines };
}
