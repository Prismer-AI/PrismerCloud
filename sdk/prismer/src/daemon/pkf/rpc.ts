/** Native loopback PKF tools for in-pod agent providers.
 *
 * Hermes exposes these as function tools; this route keeps parsing and
 * validation inside the signed Runtime bundle instead of teaching the model
 * to discover shell commands or write ad-hoc validators. The server is bound
 * to 127.0.0.1 by LocalServer and accepts no filesystem paths.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CloudClient } from '../../auth.js';
import {
  runPkfOutlineLocal,
  runPkfMintSidsLocal,
  runPkfReadLocal,
  runPkfSearchLocal,
  runPkfSvgCheckLocal,
  runPkfValidateLocal,
  type PkfQueryInput,
  type PkfValidateInput,
} from '../../adapters/memory-tools.js';
import { normalizePkfBundleCommit, PkfBundleNormalizeError, type PkfBundleNormalized } from './bundle-normalize.js';
import { runPkfReplyInlineTool } from './reply-inline.js';

const PKF_PATH_PREFIX = '/local/pkf/';
export const PKF_SOURCE_MAX_BYTES = 5 * 1024 * 1024;
export const PKF_BUNDLE_MAX_WIRE_BYTES = 6 * 1024 * 1024;
const REQUEST_OVERHEAD_BYTES = 64 * 1024;

export interface AttachPkfRpcOptions {
  cloud?: CloudClient;
  workspaceId?: () => string | null;
}

export function attachPkfRpc(opts: AttachPkfRpcOptions = {}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = req.url ?? '/';
    if (!url.startsWith(PKF_PATH_PREFIX)) return false;
    const [pathOnly = ''] = url.split('?', 2);
    const operation = pathOnly.slice(PKF_PATH_PREFIX.length);
    if ((req.method ?? 'GET') !== 'POST') {
      respond(res, 405, { ok: false, error: 'method_not_allowed' });
      return true;
    }

    try {
      const body = await readJson(
        req,
        operation === 'bundle-commit'
          ? PKF_BUNDLE_MAX_WIRE_BYTES
          : PKF_SOURCE_MAX_BYTES + REQUEST_OVERHEAD_BYTES,
      );
      if (operation === 'bundle-commit') {
        await handleBundleCommit(opts, body, readLocalAgentIdentity(req), res);
        return true;
      }
      if (operation === 'mint-sids') {
        const count = body.count === undefined ? 1 : Number(body.count);
        if (!Number.isInteger(count) || count < 1 || count > 50) {
          respond(res, 400, { ok: false, error: 'pkf_sid_count_invalid', min: 1, max: 50 });
          return true;
        }
        respond(res, 200, { ok: true, ...runPkfMintSidsLocal({ count }) });
        return true;
      }
      // pkf209 — mechanical inline-PKF delivery. Takes `path` (never source
      // bytes); resolves the calling agent's in-flight dispatch scope, so the
      // marker lands in THIS task's scratch dir. The dispatch terminal state
      // re-reads + re-validates before emitting the contentBlock.
      if (operation === 'reply-inline') {
        if (typeof body.path !== 'string' || !body.path.trim()) {
          respond(res, 400, { ok: false, error: 'pkf_reply_inline_path_required' });
          return true;
        }
        const result = await runPkfReplyInlineTool({
          agentImUserId: readLocalAgentIdentity(req),
          path: body.path,
        });
        if (result.ok) {
          respond(res, 200, {
            ok: true,
            emitted: true,
            sourceHash: result.sourceHash,
            ...(result.title ? { title: result.title } : {}),
          });
        } else {
          const statusByError: Record<string, number> = {
            pkf_reply_inline_no_active_task: 409,
            pkf_reply_inline_path_outside: 403,
            pkf_reply_inline_file_unreadable: 404,
            pkf_reply_inline_too_large: 413,
            pkf_reply_inline_invalid: 422,
          };
          respond(res, statusByError[result.error] ?? 400, {
            ok: false,
            error: result.error,
            message: result.message,
          });
        }
        return true;
      }
      // pkf209/07 §5 — the controlled-svg check loop. Pure local audit (same
      // implementation as the TS in-process tool); takes `svg`, not `source`.
      if (operation === 'svg-check') {
        const svg = typeof body.svg === 'string' ? body.svg : '';
        if (!svg.trim()) {
          respond(res, 400, { ok: false, error: 'pkf_svg_required' });
          return true;
        }
        if (Buffer.byteLength(svg, 'utf8') > PKF_SOURCE_MAX_BYTES) {
          respond(res, 413, { ok: false, error: 'pkf_source_too_large', maxBytes: PKF_SOURCE_MAX_BYTES });
          return true;
        }
        respond(res, 200, { ok: true, ...runPkfSvgCheckLocal({ svg }) });
        return true;
      }
      const source = typeof body.source === 'string' ? body.source : '';
      if (!source) {
        respond(res, 400, { ok: false, error: 'pkf_source_required' });
        return true;
      }
      if (Buffer.byteLength(source, 'utf8') > PKF_SOURCE_MAX_BYTES) {
        respond(res, 413, { ok: false, error: 'pkf_source_too_large', maxBytes: PKF_SOURCE_MAX_BYTES });
        return true;
      }

      let result: Record<string, unknown>;
      if (operation === 'validate') {
        result = runPkfValidateLocal(body as unknown as PkfValidateInput) as unknown as Record<string, unknown>;
      } else if (operation === 'outline') {
        result = runPkfOutlineLocal(body as unknown as PkfQueryInput) as unknown as Record<string, unknown>;
      } else if (operation === 'search') {
        if (typeof body.query !== 'string' || !body.query.trim()) {
          respond(res, 400, { ok: false, error: 'pkf_query_required' });
          return true;
        }
        result = runPkfSearchLocal(body as unknown as PkfQueryInput) as unknown as Record<string, unknown>;
      } else if (operation === 'read') {
        result = runPkfReadLocal(body as unknown as PkfQueryInput) as unknown as Record<string, unknown>;
      } else {
        respond(res, 404, { ok: false, error: 'pkf_route_not_found', path: url });
        return true;
      }
      respond(res, 200, { ok: true, ...result });
      return true;
    } catch (err) {
      if (err instanceof PkfBundleNormalizeError) {
        // Local fast fail (§4a): a bad self-supplied hash or malformed bundle
        // never costs a Cloud round-trip.
        respond(res, 400, { ok: false, error: err.code, message: err.message });
        return true;
      }
      if (err instanceof RequestTooLargeError) {
        respond(res, 413, {
          ok: false,
          error: operation === 'bundle-commit' ? 'pkf_bundle_request_too_large' : 'pkf_source_too_large',
          maxBytes: operation === 'bundle-commit' ? PKF_BUNDLE_MAX_WIRE_BYTES : PKF_SOURCE_MAX_BYTES,
        });
        return true;
      }
      respond(res, 422, {
        ok: false,
        error: 'pkf_operation_failed',
        message: err instanceof Error ? err.message : String(err),
      });
      return true;
    }
  };
}

type BundleView = {
  replayed: boolean;
  receipt: { id: string; state: 'committed'; requestHash: string };
  root: { id: string; revision: number; contentHash: string; filename: string; workspacePath: string };
  resources: Array<{
    id: string;
    path: string;
    contentHash: string;
    integrity: string;
    mime: string;
    usage: string;
    fromContentHash: string;
    fromNodeKey: string;
    boundKind: 'pkf-resource';
  }>;
};

type BundleEnvelope = {
  success?: boolean;
  data?: BundleView;
  error?: { code?: string; message?: string; retryable?: boolean };
  requestId?: string;
};

/**
 * pkf209/07 §4a — the model-facing input is RELAXED (content without hashes,
 * optional harnessDecl); the runtime normalizer sinks the hash/manifest/SRI
 * computation and rewrites bundle-internal references. Output is the frozen
 * server wire shape; parse/hash failures fail fast here (400) instead of a
 * Cloud 422 round-trip.
 */
function parseBundleInput(body: Record<string, unknown>, workspaceId: string): PkfBundleNormalized {
  return normalizePkfBundleCommit(body, workspaceId);
}

function sameBundle(left: BundleView, right: BundleView): boolean {
  const comparable = (view: BundleView) => ({
    receipt: view.receipt,
    root: view.root,
    resources: [...view.resources].sort((a, b) => a.path.localeCompare(b.path)),
  });
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}

async function handleBundleCommit(
  opts: AttachPkfRpcOptions,
  body: Record<string, unknown>,
  agentImUserId: string,
  res: ServerResponse,
): Promise<void> {
  const workspaceId = opts.workspaceId?.()?.trim() ?? '';
  if (!workspaceId) {
    respond(res, 409, { ok: false, error: 'pkf_bundle_workspace_unbound' });
    return;
  }
  if (!opts.cloud) {
    respond(res, 503, { ok: false, error: 'pkf_bundle_cloud_unavailable' });
    return;
  }
  if (!agentImUserId) {
    respond(res, 409, { ok: false, error: 'pkf_bundle_agent_unbound' });
    return;
  }
  const input = parseBundleInput(body, workspaceId);
  const commit = await opts.cloud.request<BundleEnvelope>('POST', '/api/pkf/bundles/commit', {
    body: { workspaceId, ...input.input },
    headers: { 'X-Prismer-Agent': agentImUserId },
    timeoutMs: 120_000,
  });
  const committed = commit.data?.success ? commit.data.data : undefined;
  if (!commit.ok || !committed) {
    respond(res, commit.status || 502, {
      ok: false,
      error: commit.data?.error?.code ?? commit.error?.code ?? 'pkf_bundle_commit_failed',
      message: commit.data?.error?.message ?? commit.error?.message,
      retryable: commit.data?.error?.retryable,
    });
    return;
  }
  const query = new URLSearchParams({ workspaceId, idempotencyKey: input.input.idempotencyKey });
  const readback = await opts.cloud.request<BundleEnvelope>(
    'GET',
    `/api/pkf/bundles/commit?${query.toString()}`,
    { headers: { 'X-Prismer-Agent': agentImUserId }, timeoutMs: 120_000 },
  );
  const canonical = readback.data?.success ? readback.data.data : undefined;
  if (!readback.ok || !canonical) {
    respond(res, readback.status || 502, {
      ok: false,
      error: readback.data?.error?.code ?? readback.error?.code ?? 'pkf_bundle_readback_failed',
      message: readback.data?.error?.message ?? readback.error?.message,
    });
    return;
  }
  if (!sameBundle(committed, canonical)) {
    respond(res, 502, { ok: false, error: 'pkf_bundle_readback_mismatch' });
    return;
  }
  respond(res, 200, {
    ok: true,
    replayed: committed.replayed,
    readbackVerified: true,
    ...(input.warnings.length > 0 ? { warnings: input.warnings } : {}),
    receipt: canonical.receipt,
    root: canonical.root,
    resources: canonical.resources,
  });
}

function readLocalAgentIdentity(req: IncomingMessage): string {
  const header = req.headers['x-prismer-agent'];
  if (Array.isArray(header)) return '';
  const value = header?.trim() ?? '';
  return value && value.length <= 191 ? value : '';
}

class RequestTooLargeError extends Error {}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) throw new RequestTooLargeError('request too large');
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
