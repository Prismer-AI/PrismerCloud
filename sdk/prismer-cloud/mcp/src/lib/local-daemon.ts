import { isToolAllowed, PrismerApiError } from './client.js';

const DEFAULT_DAEMON_PORT = 3210;

export function getLocalDaemonBaseUrl(): string {
  const explicit = process.env.PRISMER_DAEMON_URL || process.env.PRISMER_LOCAL_DAEMON_URL;
  if (explicit) return explicit.replace(/\/$/, '');

  const rawPort =
    process.env.PRISMER_DAEMON_PORT ||
    process.env.PRISMER_RUNTIME_PORT ||
    process.env.PRISMER_LOCAL_PORT ||
    String(DEFAULT_DAEMON_PORT);
  const port = Number.parseInt(rawPort, 10);
  return `http://127.0.0.1:${Number.isFinite(port) && port > 0 ? port : DEFAULT_DAEMON_PORT}`;
}

export async function localDaemonFetch(
  path: string,
  options: { body?: unknown; toolName?: string; timeoutMs?: number } = {},
): Promise<unknown> {
  const toolName = options.toolName;
  if (toolName && !isToolAllowed(toolName)) {
    throw new PrismerApiError(`tool_not_allowed_for_agent: ${toolName}`, {
      code: 'tool_not_allowed_for_agent',
      toolName,
    });
  }

  const url = new URL(path, getLocalDaemonBaseUrl());
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options.body ?? {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Local daemon unavailable at ${getLocalDaemonBaseUrl()}. Start \`prismer daemon\` on this machine, then retry. (${msg})`,
    );
  }

  const text = await response.text();
  let json: unknown = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { message: text };
    }
  }

  if (!response.ok) {
    const record = json && typeof json === 'object' && !Array.isArray(json) ? json as Record<string, unknown> : {};
    const message =
      typeof record.message === 'string'
        ? record.message
        : typeof record.error === 'string'
          ? record.error
          : `Local daemon returned ${response.status}`;
    throw new PrismerApiError(message, { status: response.status, toolName });
  }

  return json;
}
