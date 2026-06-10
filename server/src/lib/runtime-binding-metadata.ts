/**
 * Workspace runtime binding metadata helpers.
 *
 * Stored inside IMWorkspace.metadata so both Next app routes and IM services
 * can share the same forget/unforget semantics without crossing layer
 * boundaries.
 */

export interface RuntimeBindingMetadata {
  runtimeBindings?: {
    forgottenDaemonIds?: string[];
  };
  [key: string]: unknown;
}

const META_KEY = 'runtimeBindings';
const FORGOTTEN_KEY = 'forgottenDaemonIds';

function parseMetadata(metadata: string | null | undefined): RuntimeBindingMetadata {
  if (!metadata) return {};
  try {
    const parsed = JSON.parse(metadata) as RuntimeBindingMetadata;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeDaemonId(daemonId: string): string {
  return daemonId.trim();
}

function readForgottenIds(metadata: string | null | undefined): Set<string> {
  const parsed = parseMetadata(metadata);
  const raw = parsed.runtimeBindings?.forgottenDaemonIds;
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean));
}

export function getForgottenDaemonIds(metadata: string | null | undefined): string[] {
  return [...readForgottenIds(metadata)];
}

function serializeMetadata(parsed: RuntimeBindingMetadata): string {
  return JSON.stringify(parsed);
}

export function isDaemonForgotten(metadata: string | null | undefined, daemonId: string): boolean {
  return readForgottenIds(metadata).has(normalizeDaemonId(daemonId));
}

export function addForgottenDaemonId(metadata: string | null | undefined, daemonId: string): string {
  const parsed = parseMetadata(metadata);
  const forgotten = readForgottenIds(metadata);
  forgotten.add(normalizeDaemonId(daemonId));
  parsed[META_KEY] = { ...(parsed[META_KEY] as Record<string, unknown> | undefined), [FORGOTTEN_KEY]: [...forgotten] };
  return serializeMetadata(parsed);
}

export function removeForgottenDaemonId(metadata: string | null | undefined, daemonId: string): string {
  const parsed = parseMetadata(metadata);
  const forgotten = readForgottenIds(metadata);
  forgotten.delete(normalizeDaemonId(daemonId));
  const bindings = { ...(parsed[META_KEY] as Record<string, unknown> | undefined) };
  if (forgotten.size === 0) {
    delete bindings[FORGOTTEN_KEY];
    if (Object.keys(bindings).length === 0) {
      delete parsed[META_KEY];
    } else {
      parsed[META_KEY] = bindings;
    }
    return serializeMetadata(parsed);
  }
  parsed[META_KEY] = { ...bindings, [FORGOTTEN_KEY]: [...forgotten] };
  return serializeMetadata(parsed);
}
