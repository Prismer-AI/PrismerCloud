// WS-B (PP-1) — pino Logger shim for the lifted Paseo engine.
//
// Paseo's engine + providers accept an injected `pino.Logger`. We don't run a
// full pino instance inside the daemon runtime; instead we expose a concrete
// logger that satisfies the pino `Logger` interface shape Paseo uses
// (debug/info/warn/error/trace/fatal + .child()) but routes to our
// `console.log('[CodingDriver] ...')` convention.
//
// This is a structural shim, not a re-export of pino — keeping it independent
// avoids dragging pino's runtime config surface into the engine port.
import type { Logger } from "pino";

type LogArgs = unknown[];

function emit(level: string, bindings: Record<string, unknown>, args: LogArgs): void {
  // pino call shapes: (obj), (obj, msg), (msg), (msg, ...interpolation)
  let msg = "";
  const extras: unknown[] = [];
  for (const arg of args) {
    if (typeof arg === "string" && !msg) {
      msg = arg;
    } else {
      extras.push(arg);
    }
  }
  const prefix = `[CodingDriver] ${level.toUpperCase()}:`;
  const ctx = Object.keys(bindings).length ? bindings : undefined;
  if (level === "error" || level === "fatal") {
    console.error(prefix, msg, ...(ctx ? [ctx] : []), ...extras);
  } else if (level === "warn") {
    console.warn(prefix, msg, ...(ctx ? [ctx] : []), ...extras);
  } else {
    console.log(prefix, msg, ...(ctx ? [ctx] : []), ...extras);
  }
}

function makeLogger(bindings: Record<string, unknown>): Logger {
  const logFn = (level: string) => (...args: LogArgs) => emit(level, bindings, args);
  const base = {
    level: "info",
    silent: () => {},
    trace: logFn("trace"),
    debug: logFn("debug"),
    info: logFn("info"),
    warn: logFn("warn"),
    error: logFn("error"),
    fatal: logFn("fatal"),
    child(childBindings: Record<string, unknown>): Logger {
      return makeLogger({ ...bindings, ...childBindings });
    },
    bindings: () => bindings,
    isLevelEnabled: () => true,
    setBindings: () => {},
    flush: () => {},
  };
  // The pino Logger type is wider than what the engine consumes; the cast is
  // safe because the engine only calls the methods implemented above.
  return base as unknown as Logger;
}

/** Shared coding-driver logger. Inject wherever Paseo expected a `pino.Logger`. */
export const codingDriverLogger: Logger = makeLogger({});

export function createCodingDriverLogger(bindings: Record<string, unknown> = {}): Logger {
  return makeLogger(bindings);
}
