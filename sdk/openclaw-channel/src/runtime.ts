import type { PluginRuntime } from "openclaw/plugin-sdk/runtime";

let runtime: PluginRuntime | null = null;

export function setPrismerRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getPrismerRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Prismer runtime not initialized");
  }
  return runtime;
}
