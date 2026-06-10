// Agent-gen Origin — synchronous daemon-local RPC for agent-produced assets.
//
// Wired by the daemon runner as `POST /local/asset/write` on local-server.ts.
// An agent (Hermes / CC / OpenClaw / Codex) running locally generates a file
// (e.g. a chart, a derived table, a screenshot) and POSTs the bytes here.
// The daemon synchronously uploads to cloud and returns the prismer:// URI
// so the agent can immediately reference it in its reply / memory page.
//
// Auth model (per dispatcher decision in this round): the daemon uploads
// under its own owner identity; the originating agent's imUserId travels
// in metadata as `sourceAgentImUserId` (the cloud-side IMAsset column of
// the same name). Bound-agent identity at the cloud layer (B1's POST
// permission alignment) is a separate, independent change — agent-gen does
// not depend on it.

import { z } from 'zod';
import type { OriginAdapter, OriginKind, SourceBytes, SourceIdentity, SourceObservation } from './spi.js';
import type { CloudUploadClient } from './upload-runner.js';
import { validateAgentOutputAsset } from '../agent-output-policy.js';

const AssetWriteRequestSchema = z.object({
  workspaceId: z.string().min(1, 'workspaceId is required'),
  bytes: z.string().min(1, 'bytes (base64) is required'),
  filename: z.string().min(1, 'filename is required'),
  mime: z.string().optional(),
  /** Folder grouping (`folderPath` on the cloud asset row). */
  path: z.string().optional(),
  /** Optional human-readable description (cloud column added by Line B Phase 1). */
  description: z.string().max(500).optional(),
  /** im_user id of the agent that produced these bytes — passenger column, not auth. */
  sourceAgentImUserId: z.string().optional(),
});

export type AssetWriteRequest = z.infer<typeof AssetWriteRequestSchema>;

export interface AssetWriteResponse {
  assetId: string;
  contentHash: string;
  /** Canonical `prismer://workspace/<wid>/asset/<contentHash>` URI for chat / memory references. */
  prismerUri: string;
}

export type HandleAssetWriteResult =
  | { ok: true; status: 200; body: AssetWriteResponse }
  | { ok: false; status: 400 | 422 | 502; error: string };

export interface HandleAssetWriteOptions {
  cloud: CloudUploadClient;
}

/**
 * Pure handler — takes the parsed JSON body, validates, decodes bytes,
 * uploads, and returns a structured result. The HTTP framing (route
 * registration, status codes, JSON envelope) lives in local-server.ts.
 */
export async function handleAssetWrite(
  rawBody: unknown,
  opts: HandleAssetWriteOptions,
): Promise<HandleAssetWriteResult> {
  const parsed = AssetWriteRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    const first = parsed.error.errors[0];
    const fieldName = first?.path.join('.') || 'field';
    const message = first?.message ?? 'invalid request';
    // Always include the field name so the agent client can debug — Zod's
    // default "Required" message omits it, which is actively unhelpful.
    return { ok: false, status: 400, error: `${fieldName}: ${message}` };
  }
  const req = parsed.data;
  let bytes: Buffer;
  try {
    bytes = decodeBase64Strict(req.bytes);
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: err instanceof Error ? err.message : 'invalid base64 bytes',
    };
  }
  const policy = validateAgentOutputAsset({
    filename: req.filename,
    mime: req.mime ?? null,
    sizeBytes: bytes.length,
  });
  if (!policy.ok) {
    return { ok: false, status: 422, error: `agent_output_rejected: ${policy.reason}` };
  }

  const metadata: Record<string, unknown> = {
    sourceRef: `agent://${req.sourceAgentImUserId ?? 'unknown'}/${req.filename}`,
    sourceKind: 'agent-gen',
  };
  if (req.description) metadata.description = req.description;
  if (req.sourceAgentImUserId) metadata.sourceAgentImUserId = req.sourceAgentImUserId;

  try {
    const result = await opts.cloud.uploadAsset({
      workspaceId: req.workspaceId,
      filename: req.filename,
      bytes,
      mime: policy.mime,
      size: bytes.length,
      metadata,
      folderPath: req.path,
    });
    return {
      ok: true,
      status: 200,
      body: {
        assetId: result.assetId,
        contentHash: result.contentHash,
        prismerUri: `prismer://workspace/${req.workspaceId}/asset/${result.contentHash}`,
      },
    };
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Strict base64 decoder. `Buffer.from(s, 'base64')` is permissive — it silently
 * skips invalid characters AND tolerates a length that isn't a multiple of 4
 * by truncating to the nearest valid block. Both cases would upload corrupted
 * bytes with no error.
 *
 * We enforce three invariants to catch both classes:
 *
 *   1. Alphabet: `[A-Za-z0-9+/]` body, `={0,2}` trailing padding.
 *   2. Length: must be a multiple of 4 (after removing whitespace).
 *   3. Round-trip: re-encode the decoded buffer and compare to the cleaned
 *      input (after normalizing trailing `=` padding). If they differ, the
 *      input was malformed in a way the alphabet+length checks didn't catch.
 *
 * Whitespace in the input is stripped because some agents will pretty-print
 * base64 with line breaks; the cleaned form is what we validate against.
 */
function decodeBase64Strict(s: string): Buffer {
  const cleaned = s.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) {
    throw new Error('bytes is not valid base64 (invalid characters)');
  }
  if (cleaned.length === 0) {
    throw new Error('bytes is empty');
  }
  if (cleaned.length % 4 !== 0) {
    throw new Error('bytes is not valid base64 (length must be a multiple of 4 including padding)');
  }
  const buf = Buffer.from(cleaned, 'base64');
  const reEncoded = buf.toString('base64');
  // Normalize trailing `=` padding for comparison: standard base64 always
  // pads to a multiple of 4, and we already enforced that on `cleaned`,
  // so a direct equality check is correct.
  if (reEncoded !== cleaned) {
    throw new Error('bytes is not valid base64 (round-trip mismatch)');
  }
  return buf;
}

/**
 * Trivial OriginAdapter implementation for spec conformance / SPI tests.
 * Not used by the route handler — agent-gen is fundamentally synchronous
 * and doesn't fit the polling observe() / outbox model. The adapter exists
 * so the daemon can declare a uniform `adapters` map keyed by OriginKind.
 */
export class AgentGenAdapter implements OriginAdapter {
  readonly kind: OriginKind = 'agent-gen';

  async *observe(): AsyncIterable<SourceObservation> {
    // No-op: agent-gen is push-driven via RPC, not polled.
  }

  async identifySource(obs: SourceObservation): Promise<SourceIdentity> {
    const filename = (obs.detail.filename as string | undefined) ?? 'unknown';
    const agentId = (obs.detail.sourceAgentImUserId as string | undefined) ?? 'unknown';
    return {
      sourceRef: `agent://${agentId}/${filename}`,
      hints: {
        filename,
        sourceAgentImUserId: agentId,
        description: obs.detail.description as string | undefined,
      },
    };
  }

  async fetch(obs: SourceObservation): Promise<SourceBytes> {
    const bytes = obs.detail.bytes as Buffer | undefined;
    if (!bytes) throw new Error('agent-gen observation missing bytes');
    return {
      bytes,
      mime: (obs.detail.mime as string | null | undefined) ?? null,
      size: bytes.length,
    };
  }
}
