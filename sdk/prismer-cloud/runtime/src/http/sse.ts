// SSE subscription handler — extracted from daemon-http.ts (Q1 split).

import type * as http from 'node:http';
import type { EventBus, EventBusEnvelope } from '../event-bus.js';
import { sendJson, topicMatches } from './helpers.js';

export const SSE_HEARTBEAT_MS = 15_000;
export const MAX_SSE_CLIENTS = 50;

export interface SseDeps {
  bus: EventBus;
  sseClients: Set<http.ServerResponse>;
}

export function handleSse(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  deps: SseDeps,
): void {
  if (deps.sseClients.size >= MAX_SSE_CLIENTS) {
    sendJson(res, 503, { error: 'too-many-sse-clients' });
    return;
  }

  const topicsParam = url.searchParams.get('topics') ?? '*';
  const patterns = topicsParam
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.flushHeaders();

  deps.sseClients.add(res);

  // Per-client write helper.
  const send = (envelope: EventBusEnvelope): void => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(envelope)}\n\n`);
  };

  // Subscribe for each requested topic pattern.
  const subs = patterns.map((pattern) =>
    deps.bus.subscribe(pattern, (ev) => {
      if (patterns.some((p) => topicMatches(ev.topic, p))) {
        send(ev);
      }
    }),
  );

  // Heartbeat every 15s.
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': heartbeat\n\n');
    }
  }, SSE_HEARTBEAT_MS);
  heartbeat.unref();

  const cleanup = (): void => {
    clearInterval(heartbeat);
    for (const sub of subs) sub.unsubscribe();
    deps.sseClients.delete(res);
  };

  req.on('close', cleanup);
  res.on('close', cleanup);
}
