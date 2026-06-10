import { describe, expect, it } from 'vitest';

import {
  deriveDeliveryProgress,
  deriveAssetDeliveryProgress,
} from '../delivery-progress';

describe('deriveDeliveryProgress', () => {
  it('settles to ready when a preview has resolved', () => {
    const p = deriveDeliveryProgress({
      thumbnailEligible: true,
      hasPreview: true,
      generating: false,
      failed: false,
    });
    expect(p.stage).toBe('ready');
    expect(p.settled).toBe(true);
    expect(p.inFlight).toBe(false);
  });

  it('failed is terminal and wins over everything', () => {
    const p = deriveDeliveryProgress({
      thumbnailEligible: true,
      hasPreview: true, // even with a preview, an explicit failure dominates
      generating: true,
      failed: true,
    });
    expect(p.stage).toBe('failed');
    expect(p.settled).toBe(true);
  });

  it('shows previewing while a thumbnail derivative is generating', () => {
    const p = deriveDeliveryProgress({
      thumbnailEligible: true,
      hasPreview: false,
      generating: true,
      failed: false,
    });
    expect(p.stage).toBe('previewing');
    expect(p.inFlight).toBe(true);
    expect(p.label).toMatch(/preview/i);
  });

  it('a thumbnail-eligible asset with no preview yet sits at asset-ready', () => {
    const p = deriveDeliveryProgress({
      thumbnailEligible: true,
      hasPreview: false,
      generating: false,
      failed: false,
    });
    expect(p.stage).toBe('asset-ready');
    expect(p.inFlight).toBe(true);
  });

  it('a non-previewable file is usable immediately (ready)', () => {
    const p = deriveDeliveryProgress({
      thumbnailEligible: false,
      hasPreview: false,
      generating: false,
      failed: false,
    });
    expect(p.stage).toBe('ready');
    expect(p.settled).toBe(true);
  });

  it('uploading (human-send) takes precedence over asset-ready', () => {
    const p = deriveDeliveryProgress({
      thumbnailEligible: true,
      hasPreview: false,
      generating: false,
      failed: false,
      uploading: true,
    });
    expect(p.stage).toBe('uploading');
  });

  it('ratio is monotonic across the in-flight stages', () => {
    const order = ['uploading', 'asset-ready', 'previewing', 'ready'] as const;
    const ratios = order.map(
      (stage) =>
        deriveDeliveryProgress({
          thumbnailEligible: stage !== 'uploading',
          hasPreview: stage === 'ready',
          generating: stage === 'previewing',
          failed: false,
          uploading: stage === 'uploading',
        }).ratio,
    );
    for (let i = 1; i < ratios.length; i += 1) {
      expect(ratios[i]).toBeGreaterThan(ratios[i - 1]);
    }
  });
});

describe('deriveAssetDeliveryProgress (right-rail coarse signals)', () => {
  it('PDF with no thumbnail + asset-only ingest is still preparing preview', () => {
    const p = deriveAssetDeliveryProgress({
      mime: 'application/pdf',
      kind: 'document',
      ingestStatus: 'asset-only',
      hasThumbnail: false,
    });
    expect(p.stage).toBe('previewing');
  });

  it('image with a resolved thumbnail is ready', () => {
    const p = deriveAssetDeliveryProgress({
      mime: 'image/png',
      kind: 'image',
      ingestStatus: 'indexed',
      hasThumbnail: true,
    });
    expect(p.stage).toBe('ready');
  });

  it('failed ingest surfaces a failed terminal state', () => {
    const p = deriveAssetDeliveryProgress({
      mime: 'application/pdf',
      kind: 'document',
      ingestStatus: 'failed',
      hasThumbnail: false,
    });
    expect(p.stage).toBe('failed');
    expect(p.label).toMatch(/fail/i);
  });

  it('a plain text file (non-previewable) is ready immediately', () => {
    const p = deriveAssetDeliveryProgress({
      mime: 'text/plain',
      kind: 'document',
      ingestStatus: 'asset-only',
      hasThumbnail: false,
    });
    expect(p.stage).toBe('ready');
  });
});
