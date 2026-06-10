// Web Upload Origin — cloud-side, declared here for SPI symmetry.
//
// This adapter does NOT execute any work in the daemon. The actual handler
// is the cloud-side `POST /api/im/assets` multipart route at
// `src/im/api/assets.ts:737` (router.post('/'), validating + dedup + S3
// write + IMAsset insert). The OriginAdapter SPI is daemon-side; its
// `'upload'` kind is the conceptual marker that says "Web upload is also
// an OriginAdapter — its observe/identify/fetch happen on the cloud side
// inside the multipart handler".
//
// What this file gives you:
//   - A constant `WEB_UPLOAD_ORIGIN_KIND` for cross-package referencing
//   - A `WebUploadAdapter` class that satisfies OriginAdapter at the type
//     level so a daemon-side adapters map can declare it; calling its
//     methods throws (intentionally — there is no daemon-side runtime to
//     execute against). Use `OriginAdapter` typing where you want the kind
//     enum to cover all three producers.
//
// What this file does NOT give you: an actual upload mechanism. If a daemon
// process needs to push a Web-style upload, use the agent-gen adapter — it
// IS the daemon-local equivalent of the Web upload route.

import type {
  OriginAdapter,
  OriginKind,
  SourceBytes,
  SourceIdentity,
  SourceObservation,
} from './spi.js';

export const WEB_UPLOAD_ORIGIN_KIND: OriginKind = 'upload';

const NOT_DAEMON_SIDE =
  'WebUploadAdapter is a marker for the cloud-side POST /api/im/assets handler. ' +
  'Its observe/identify/fetch run there, not in the daemon. ' +
  'Use AgentGenAdapter for daemon-local agent-produced uploads.';

/**
 * Verify the cloud-side handler advertises this kind. Pure check exposed so
 * a downstream test (or future cross-package wiring) can assert the SPI
 * realization stays in sync with the cloud-side multipart handler's
 * sourceKind metadata default.
 */
export function isWebUploadSourceKind(value: string | null | undefined): boolean {
  return value === WEB_UPLOAD_ORIGIN_KIND || value === 'upload';
}

export class WebUploadAdapter implements OriginAdapter {
  readonly kind: OriginKind = WEB_UPLOAD_ORIGIN_KIND;

  // eslint-disable-next-line require-yield
  async *observe(): AsyncIterable<SourceObservation> {
    throw new Error(NOT_DAEMON_SIDE);
  }

  async identifySource(_obs: SourceObservation): Promise<SourceIdentity> {
    throw new Error(NOT_DAEMON_SIDE);
  }

  async fetch(_obs: SourceObservation): Promise<SourceBytes> {
    throw new Error(NOT_DAEMON_SIDE);
  }
}
