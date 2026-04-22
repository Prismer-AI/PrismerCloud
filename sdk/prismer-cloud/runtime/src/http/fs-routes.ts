// FS route handlers — extracted from daemon-http.ts (Q1 split).
// Each function is a standalone route handler; the server wires them in.
// C2: every handler receives `authed` (authenticated identity or null).
// G2: FsContext is built with callPath: 'http' so audit logs reflect origin.

import type * as http from 'node:http';
import type { FsContext } from '@prismer/sandbox-runtime';
import {
  fsRead,
  fsWrite,
  fsDelete,
  fsEdit,
  fsList,
  fsSearch,
  UncPathError,
  OutsideSandboxError,
  PermissionDeniedError,
} from '@prismer/sandbox-runtime';
import { sendJson, parseBody, readBody } from './helpers.js';
import type { AuthenticatedIdentity } from '../daemon-http.js';

// ============================================================
// Dependency interface
// ============================================================

export interface FsRoutesDeps {
  /** Resolve FsContext from agent identity; returns undefined if FS not configured. */
  fsContextProvider?: (req: { agentId: string; workspace?: string }) => FsContext | undefined;
}

// ============================================================
// resolveAgentId — C2 identity reconciliation
//
// Rules:
//   - If authed is non-null (authenticate IS configured):
//       * No body agentId → use authed.agentId.
//       * Body agentId present and matches authed.agentId → OK, use it.
//       * Body agentId present but differs → 403 agent-mismatch.
//   - If authed is null (localhost trust mode / no authenticate):
//       * Fall back to body agentId (existing behavior).
//       * If body agentId is also absent → return null (caller returns 400).
// Returns { agentId: string } on success, or throws a sentinel to signal
// a 403/400 response (we return null + side-effect on res instead).
// ============================================================

export function resolveAgentId(
  res: http.ServerResponse,
  bodyAgentId: string | undefined,
  authed: AuthenticatedIdentity | null,
): string | null {
  if (authed !== null) {
    // Authenticated mode
    if (bodyAgentId !== undefined && bodyAgentId !== authed.agentId) {
      sendJson(res, 403, {
        error: 'agent-mismatch',
        message: 'body agentId does not match authenticated identity',
      });
      return null;
    }
    return authed.agentId;
  }
  // Trust mode — body agentId
  if (bodyAgentId === undefined || bodyAgentId === '') {
    sendJson(res, 400, { error: 'missing-agent-id' });
    return null;
  }
  return bodyAgentId;
}

// ============================================================
// Build FsContext with callPath: 'http' (G2)
// ============================================================

function getFsCtx(
  deps: FsRoutesDeps,
  agentId: string,
  workspace?: string,
): FsContext | undefined {
  if (!deps.fsContextProvider) return undefined;
  const ctx = deps.fsContextProvider({ agentId, workspace });
  if (!ctx) return undefined;
  // G2: stamp callPath so audit entries reflect HTTP origin
  return { ...ctx, callPath: 'http' };
}

// ============================================================
// mapFsError — translate fs-adapter errors to HTTP status codes
// ============================================================

export function mapFsError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof UncPathError) {
    sendJson(res, 400, { error: 'unc-path', message: (err as Error).message });
    return;
  }
  if (err instanceof OutsideSandboxError) {
    sendJson(res, 403, { error: 'outside-sandbox', message: (err as Error).message });
    return;
  }
  if (err instanceof PermissionDeniedError) {
    sendJson(res, 403, { error: 'permission-denied', message: (err as Error).message });
    return;
  }
  if (
    err instanceof Error &&
    'code' in err &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  ) {
    sendJson(res, 404, { error: 'not-found', message: (err as Error).message });
    return;
  }
  const name = err instanceof Error ? err.name : 'Error';
  const message = err instanceof Error ? err.message : String(err);
  sendJson(res, 500, { error: name, message });
}

// ============================================================
// Helper: read body and resolve agentId together (used by all FS handlers)
// Returns [buf, agentId] or null if a response was already sent.
// ============================================================

async function readBodyAndResolveAgent(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authed: AuthenticatedIdentity | null,
): Promise<[Buffer, string] | null> {
  let buf: Buffer;
  try {
    buf = await readBody(req);
  } catch (err: unknown) {
    if (err instanceof Error && (err as Error & { code?: string }).code === 'E_TOO_LARGE') {
      sendJson(res, 413, { error: 'body-too-large', max: 10 * 1024 * 1024 });
      return null;
    }
    sendJson(res, 400, { error: 'read-error' });
    return null;
  }

  const parsed = parseBody(buf);
  if (parsed === undefined) {
    sendJson(res, 400, { error: 'bad-json' });
    return null;
  }

  const bodyObj = parsed as Record<string, unknown>;
  const bodyAgentId = typeof bodyObj['agentId'] === 'string' ? bodyObj['agentId'] : undefined;
  const agentId = resolveAgentId(res, bodyAgentId, authed);
  if (agentId === null) return null;

  return [buf, agentId];
}

// ============================================================
// FS route handlers
// ============================================================

export async function handleFsRead(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: FsRoutesDeps,
  authed: AuthenticatedIdentity | null,
): Promise<void> {
  const pair = await readBodyAndResolveAgent(req, res, authed);
  if (pair === null) return;
  const [buf, agentId] = pair;

  const body = parseBody(buf) as { path: string; offset?: number; limit?: number; workspace?: string };
  const ctx = getFsCtx(deps, agentId, body.workspace);
  if (!ctx) { sendJson(res, 503, { error: 'fs-adapter-not-configured' }); return; }

  try {
    const result = await fsRead(ctx, { path: body.path, offset: body.offset, limit: body.limit });
    sendJson(res, 200, result);
  } catch (err) {
    mapFsError(res, err);
  }
}

export async function handleFsWrite(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: FsRoutesDeps,
  authed: AuthenticatedIdentity | null,
): Promise<void> {
  const pair = await readBodyAndResolveAgent(req, res, authed);
  if (pair === null) return;
  const [buf, agentId] = pair;

  const body = parseBody(buf) as { path: string; content: string; encoding?: 'utf8' | 'base64'; workspace?: string };
  const ctx = getFsCtx(deps, agentId, body.workspace);
  if (!ctx) { sendJson(res, 503, { error: 'fs-adapter-not-configured' }); return; }

  try {
    const result = await fsWrite(ctx, { path: body.path, content: body.content, encoding: body.encoding });
    sendJson(res, 200, result);
  } catch (err) {
    mapFsError(res, err);
  }
}

export async function handleFsDelete(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: FsRoutesDeps,
  authed: AuthenticatedIdentity | null,
): Promise<void> {
  const pair = await readBodyAndResolveAgent(req, res, authed);
  if (pair === null) return;
  const [buf, agentId] = pair;

  const body = parseBody(buf) as { path: string; workspace?: string };
  const ctx = getFsCtx(deps, agentId, body.workspace);
  if (!ctx) { sendJson(res, 503, { error: 'fs-adapter-not-configured' }); return; }

  try {
    const result = await fsDelete(ctx, { path: body.path });
    sendJson(res, 200, result);
  } catch (err) {
    mapFsError(res, err);
  }
}

export async function handleFsEdit(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: FsRoutesDeps,
  authed: AuthenticatedIdentity | null,
): Promise<void> {
  const pair = await readBodyAndResolveAgent(req, res, authed);
  if (pair === null) return;
  const [buf, agentId] = pair;

  const body = parseBody(buf) as {
    path: string;
    oldString: string;
    newString: string;
    replaceAll?: boolean;
    workspace?: string;
  };
  const ctx = getFsCtx(deps, agentId, body.workspace);
  if (!ctx) { sendJson(res, 503, { error: 'fs-adapter-not-configured' }); return; }

  try {
    const result = await fsEdit(ctx, {
      path: body.path,
      oldString: body.oldString,
      newString: body.newString,
      replaceAll: body.replaceAll,
    });
    sendJson(res, 200, result);
  } catch (err) {
    mapFsError(res, err);
  }
}

export async function handleFsList(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: FsRoutesDeps,
  authed: AuthenticatedIdentity | null,
): Promise<void> {
  const pair = await readBodyAndResolveAgent(req, res, authed);
  if (pair === null) return;
  const [buf, agentId] = pair;

  const body = parseBody(buf) as { path: string; maxDepth?: number; workspace?: string };
  const ctx = getFsCtx(deps, agentId, body.workspace);
  if (!ctx) { sendJson(res, 503, { error: 'fs-adapter-not-configured' }); return; }

  try {
    const result = await fsList(ctx, { path: body.path, maxDepth: body.maxDepth });
    sendJson(res, 200, result);
  } catch (err) {
    mapFsError(res, err);
  }
}

export async function handleFsSearch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: FsRoutesDeps,
  authed: AuthenticatedIdentity | null,
): Promise<void> {
  const pair = await readBodyAndResolveAgent(req, res, authed);
  if (pair === null) return;
  const [buf, agentId] = pair;

  const body = parseBody(buf) as { query: string; path?: string; glob?: string; workspace?: string };
  const ctx = getFsCtx(deps, agentId, body.workspace);
  if (!ctx) { sendJson(res, 503, { error: 'fs-adapter-not-configured' }); return; }

  try {
    const result = await fsSearch(ctx, { query: body.query, path: body.path, glob: body.glob });
    sendJson(res, 200, result);
  } catch (err) {
    mapFsError(res, err);
  }
}
