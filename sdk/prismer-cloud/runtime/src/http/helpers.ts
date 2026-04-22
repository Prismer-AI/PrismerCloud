// HTTP layer shared helpers — constants, readBody, sendJson, topic utilities.

import type * as http from 'node:http';

// ============================================================
// Constants
// ============================================================

export const DEFAULT_PORT = 3210;
export const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

// ============================================================
// sendJson
// ============================================================

export function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// ============================================================
// readBody — destroys the request stream on oversize (I5)
// ============================================================

export function readBody(req: http.IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        // Drain remaining data so the response can be flushed to the client
        // before the connection is torn down. Memory safety: we stop accumulating
        // into `chunks` immediately; the OS buffers are discarded as they drain.
        req.resume();
        // Destroy after the current tick so the 413 response has a chance to flush.
        setImmediate(() => req.destroy(new Error('body-too-large')));
        reject(Object.assign(new Error('body-too-large'), { code: 'E_TOO_LARGE' }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

// ============================================================
// parseBody
// ============================================================

export function parseBody(buf: Buffer): unknown {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return undefined;
  }
}

// ============================================================
// extractBearer
// ============================================================

export function extractBearer(req: http.IncomingMessage): string | undefined {
  const auth = req.headers['authorization'];
  if (!auth) return undefined;
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return undefined;
}

// ============================================================
// SSE topic matching
// ============================================================

export function topicMatches(topic: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -1);
    return topic.startsWith(prefix);
  }
  return topic === pattern;
}
