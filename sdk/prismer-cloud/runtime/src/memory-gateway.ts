import * as crypto from 'node:crypto';
import { MemoryDB, type EncryptionConfig, deriveKey, generateSalt } from './memory-db.js';
import type { RouteHandler } from './daemon-http.js';
import { sendJson } from './http/helpers.js';

const LOG = '[MemoryGatewayAPI]';

export interface WriteMemoryRequest {
  ownerId: string;
  ownerType: 'user' | 'agent';
  path: string;
  content: string;
  scope?: string;
  memoryType?: string;
  description?: string;
  encrypt?: boolean;
}

export interface RecallRequest {
  keyword: string;
  ownerId?: string;
  scope?: string;
  limit?: number;
  useCloudFallback?: boolean;
}

export interface ListMemoryRequest {
  ownerId?: string;
  scope?: string;
  path?: string;
  memoryType?: string;
  stale?: boolean;
  limit?: number;
  offset?: number;
}

export interface MemoryResponse {
  success: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

function parseJsonBody<T>(buf: Buffer): T {
  if (buf.length === 0) return {} as T;
  return JSON.parse(buf.toString('utf8')) as T;
}

function parseQuery(reqUrl: string | undefined): URLSearchParams {
  return new URL(reqUrl ?? '/', 'http://localhost').searchParams;
}

function extractId(reqUrl: string | undefined): string | null {
  const pathname = new URL(reqUrl ?? '/', 'http://localhost').pathname;
  const match = pathname.match(/\/memory\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

export interface MemoryGatewayAPIOptions {
  filePath?: string;
}

export class MemoryGatewayAPI {
  private readonly db: MemoryDB;

  constructor(
    encryptionConfig: EncryptionConfig = { enabled: false },
    opts: MemoryGatewayAPIOptions = {},
  ) {
    this.db = new MemoryDB(encryptionConfig, { filePath: opts.filePath });
  }

  handleWrite: RouteHandler = async (_req, res, ctx) => {
    try {
      const body = parseJsonBody<WriteMemoryRequest>(ctx.body);
      if (!body.ownerId || !body.ownerType || !body.path || body.content === undefined) {
        return sendJson(res, 400, {
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'Missing required fields: ownerId, ownerType, path, content',
          },
        });
      }

      const file = this.db.writeMemoryFile({
        ownerId: body.ownerId,
        ownerType: body.ownerType,
        scope: body.scope,
        path: body.path,
        content: body.content,
        memoryType: body.memoryType,
        description: body.description,
      });

      console.log(`${LOG} Write: ${file.scope}/${file.path} (${file.id})`);
      sendJson(res, 200, {
        success: true,
        ok: true,
        data: file,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${LOG} Write error:`, msg);
      sendJson(res, 500, {
        success: false,
        error: {
          code: 'WRITE_ERROR',
          message: msg,
        },
      });
    }
  };

  handleRecall: RouteHandler = async (_req, res, ctx) => {
    try {
      const body = parseJsonBody<RecallRequest>(ctx.body);
      if (!body.keyword) {
        return sendJson(res, 400, {
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'Missing required field: keyword',
          },
        });
      }

      const startTime = Date.now();
      const results = this.db.searchMemoryFiles(body.keyword, {
        ownerId: body.ownerId,
        scope: body.scope,
        limit: body.limit ?? 10,
      });
      const durationMs = Date.now() - startTime;

      sendJson(res, 200, {
        success: true,
        ok: true,
        data: {
          results,
          query: body.keyword,
          count: results.length,
          durationMs,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${LOG} Recall error:`, msg);
      sendJson(res, 500, {
        success: false,
        error: {
          code: 'RECALL_ERROR',
          message: msg,
        },
      });
    }
  };

  handleDelete: RouteHandler = async (req, res) => {
    try {
      const id = extractId(req.url);
      if (!id) {
        return sendJson(res, 400, {
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'Missing required parameter: id',
          },
        });
      }

      const deleted = this.db.deleteMemoryFile(id);
      if (!deleted) {
        return sendJson(res, 404, {
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: `Memory file not found: ${id}`,
          },
        });
      }

      console.log(`${LOG} Delete: ${id}`);
      sendJson(res, 200, {
        success: true,
        ok: true,
        data: { id },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${LOG} Delete error:`, msg);
      sendJson(res, 500, {
        success: false,
        error: {
          code: 'DELETE_ERROR',
          message: msg,
        },
      });
    }
  };

  handleList: RouteHandler = async (req, res) => {
    try {
      const query = parseQuery(req.url);
      const staleRaw = query.get('stale');
      const files = this.db.listMemoryFiles({
        ownerId: query.get('ownerId') ?? undefined,
        scope: query.get('scope') ?? undefined,
        path: query.get('path') ?? undefined,
        memoryType: query.get('memoryType') ?? undefined,
        stale: staleRaw === null ? undefined : staleRaw === 'true',
        limit: query.get('limit') ? parseInt(query.get('limit') ?? '50', 10) : undefined,
        offset: query.get('offset') ? parseInt(query.get('offset') ?? '0', 10) : undefined,
      });

      sendJson(res, 200, {
        success: true,
        ok: true,
        data: {
          files,
          count: files.length,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${LOG} List error:`, msg);
      sendJson(res, 500, {
        success: false,
        error: {
          code: 'LIST_ERROR',
          message: msg,
        },
      });
    }
  };

  handleStats: RouteHandler = async (req, res) => {
    try {
      const query = parseQuery(req.url);
      const stats = this.db.getStats(query.get('ownerId') ?? undefined);
      sendJson(res, 200, {
        success: true,
        ok: true,
        data: stats,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${LOG} Stats error:`, msg);
      sendJson(res, 500, {
        success: false,
        error: {
          code: 'STATS_ERROR',
          message: msg,
        },
      });
    }
  };

  registerRoutes(daemon: {
    registerRoute: (
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
      path: string,
      handler: RouteHandler,
    ) => void;
  }): void {
    daemon.registerRoute('POST', '/memory/write', this.handleWrite);
    daemon.registerRoute('POST', '/memory/recall', this.handleRecall);
    daemon.registerRoute('DELETE', '/memory/:id', this.handleDelete);
    daemon.registerRoute('GET', '/memory', this.handleList);
    daemon.registerRoute('GET', '/memory/stats', this.handleStats);

    console.log(`${LOG} Registered memory routes`);
  }

  shutdown(): void {
    this.db.close();
    console.log(`${LOG} Shutdown complete`);
  }
}

export function buildEncryptionConfig(password?: string): EncryptionConfig {
  if (!password) {
    return { enabled: false };
  }

  const salt = generateSalt();
  const key = deriveKey(password, salt);

  return {
    enabled: true,
    key,
  };
}

let gatewayAPIInstance: MemoryGatewayAPI | null = null;

export function getMemoryGatewayAPI(
  encryptionConfig?: EncryptionConfig,
  opts?: MemoryGatewayAPIOptions,
): MemoryGatewayAPI {
  if (!gatewayAPIInstance) {
    gatewayAPIInstance = new MemoryGatewayAPI(encryptionConfig, opts);
  }
  return gatewayAPIInstance;
}

export function closeMemoryGatewayAPI(): void {
  if (gatewayAPIInstance) {
    gatewayAPIInstance.shutdown();
    gatewayAPIInstance = null;
  }
}

export function createMemoryId(): string {
  return crypto.randomUUID();
}
