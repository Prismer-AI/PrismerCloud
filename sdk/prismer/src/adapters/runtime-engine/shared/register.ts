import type { AdapterDef } from "../../contract.js";
import { piCoreAdapter } from "../pi-core/index.js";

/**
 * Runtime engine adapters are local agent engines embedded in sdk/prismer.
 * They still expose AdapterDef names for Cloud profile compatibility, but they
 * are not coding harness providers.
 */
export function buildRuntimeAgentEngineAdapters(): AdapterDef[] {
  return [piCoreAdapter];
}
