/**
 * `delivery-progress` — pure derivation that collapses the async
 * agent-file-delivery chain into ONE ordered progress stage the UI can
 * render as a single "Delivering" affordance.
 *
 * P5#4 (docs/release202/09 §3.4 「交付进度动画」). A delivered file goes
 * through a multi-stage async chain before it is usable in the web client:
 *
 *   runtime artifacts/ → daemon uploads → asset created
 *     → asset.changed event → appears in session right rail
 *     → thumbnail derived (pdftoppm/sharp/qpdf) → previewable
 *
 * The user used to see "the agent said it sent a file" but couldn't open
 * it and had no idea whether it was still converting or had failed. This
 * helper UNIFIES the signals that ALREADY EXIST in the frontend (it does
 * NOT add a new polling loop or fabricate a new event):
 *
 *   - asset row present (message.new carried the attachment)  → `asset-ready`
 *   - thumbnail still deriving (`useAssetThumbnail.generating`) → `previewing`
 *   - thumbnail/bytes resolved                                  → `ready`
 *   - ingestStatus === 'failed' OR derivative poll exhausted    → `failed`
 *
 * No React, no fetch, no globals — the caller assembles the observable
 * booleans and receives a flat `DeliveryProgress`. This keeps the stage
 * machine unit-testable and lets both the message bubble and the right
 * rail drive the SAME affordance off one source of truth.
 *
 * Honest gap (reported, not faked): the frontend has NO distinct signal
 * for the *daemon-side upload* stage of an AGENT delivery. The optimistic
 * echo (`im-channel.tsx optimisticByIdemKey`) and the composer `uploading`
 * phase (`page.tsx` uploadPhaseLabel) only exist for the HUMAN's own
 * sends. For an agent-delivered file the first thing the human observes is
 * the `message.new` echo — by which point the asset row already exists.
 * So the unified state STARTS at `asset-ready`; an `uploading` stage is
 * declared in the enum for completeness / human-send reuse but the
 * agent-delivery path degrades gracefully to the stages it can observe.
 */

export type DeliveryStage =
  /** Human-send only: bytes still uploading (composer path). Agent deliveries
   * never observe this — they start at `asset-ready`. */
  | 'uploading'
  /** Asset row exists (message.new echoed the attachment) but no preview yet. */
  | 'asset-ready'
  /** A thumbnail/first-page derivative is still rendering server-side. */
  | 'previewing'
  /** Preview (thumbnail or inline bytes) resolved — clickable real attachment. */
  | 'ready'
  /** Terminal failure — ingest failed or the derivative never landed. */
  | 'failed';

export interface DeliveryProgress {
  stage: DeliveryStage;
  /** True while the chain is mid-flight (not yet settled to ready/failed). */
  inFlight: boolean;
  /** True once the attachment is a real clickable card (no affordance needed). */
  settled: boolean;
  /** Short label for the inline affordance. */
  label: string;
  /** 0..1 coarse progress for an optional bar/skeleton (monotonic per stage). */
  ratio: number;
}

export interface DeriveDeliveryProgressInput {
  /** Whether this mime can ever produce a thumbnail (image/pdf). */
  thumbnailEligible: boolean;
  /** A preview URL (thumbnail or public/inline) has resolved. */
  hasPreview: boolean;
  /** A thumbnail derivative is still being rendered server-side. */
  generating: boolean;
  /** Terminal: ingestStatus==='failed' OR derivative poll exhausted w/o URL. */
  failed: boolean;
  /** Human-send only — composer bytes still uploading. */
  uploading?: boolean;
}

const STAGE_LABEL: Record<DeliveryStage, string> = {
  uploading: 'Uploading…',
  'asset-ready': 'Delivering…',
  previewing: 'Preparing preview…',
  ready: 'Ready',
  failed: 'Delivery failed',
};

const STAGE_RATIO: Record<DeliveryStage, number> = {
  uploading: 0.2,
  'asset-ready': 0.45,
  previewing: 0.75,
  ready: 1,
  failed: 1,
};

/**
 * Collapse the observable booleans into one ordered stage.
 *
 * Precedence (terminal first, then most-advanced in-flight stage):
 *   failed  >  ready  >  previewing  >  uploading  >  asset-ready
 */
export function deriveDeliveryProgress(input: DeriveDeliveryProgressInput): DeliveryProgress {
  const { thumbnailEligible, hasPreview, generating, failed, uploading } = input;

  let stage: DeliveryStage;
  if (failed) {
    stage = 'failed';
  } else if (hasPreview) {
    stage = 'ready';
  } else if (uploading) {
    stage = 'uploading';
  } else if (thumbnailEligible && generating) {
    stage = 'previewing';
  } else {
    // Asset row exists but either is non-previewable (generic file → already
    // clickable) or has no derivative yet. Non-previewable files are usable
    // immediately, so they settle to ready; previewable-but-not-yet-resolved
    // sits at asset-ready until `generating` flips on.
    stage = thumbnailEligible ? 'asset-ready' : 'ready';
  }

  const settled = stage === 'ready' || stage === 'failed';
  return {
    stage,
    inFlight: !settled,
    settled,
    label: STAGE_LABEL[stage],
    ratio: STAGE_RATIO[stage],
  };
}

/**
 * Right-rail variant — derive the SAME progress state from the coarse
 * signals carried on an asset row (no per-asset thumbnail poll hook is
 * available in the sidebar). Uses only fields already on the DTO:
 *
 *   - `ingestStatus === 'failed'`                          → `failed`
 *   - thumbnail-eligible + a thumbnail/preview URL present → `ready`
 *   - thumbnail-eligible + ingest still asset-only/pending → `previewing`
 *   - everything else (non-previewable / ingest done)      → `ready`
 *
 * This is intentionally coarser than the message-bubble path (the sidebar
 * has no derivative-poll timer), but it reads off the same stage machine so
 * the two surfaces stay visually consistent — a file that is still
 * converting shows "Preparing preview…" in BOTH places.
 */
export function deriveAssetDeliveryProgress(input: {
  mime?: string | null;
  kind?: string | null;
  ingestStatus?: string | null;
  hasThumbnail: boolean;
}): DeliveryProgress {
  const mime = (input.mime ?? '').toLowerCase();
  const kind = (input.kind ?? '').toLowerCase();
  const thumbnailEligible =
    mime.startsWith('image/') ||
    kind === 'image' ||
    mime === 'application/pdf' ||
    mime.endsWith('/pdf');
  const ingest = input.ingestStatus ?? '';
  const failed = ingest === 'failed';
  // Ingest is still settling AND no preview yet ⇒ still deriving.
  const pending = ingest === 'asset-only' || ingest === 'pending' || ingest === '';
  return deriveDeliveryProgress({
    thumbnailEligible,
    hasPreview: input.hasThumbnail,
    generating: thumbnailEligible && !input.hasThumbnail && pending,
    failed,
  });
}
