import { z } from "zod";
import type { AdapterDef, AgentProfile } from "../../contract.js";
import { makeRuntimeAgentEngineAdapter } from "../shared/make-runtime-agent-engine-adapter.js";
import { PiAgentCoreClient, type PiAgentCoreClientOptions, PI_CORE_PROVIDER } from "./agent.js";

export const PiCoreConfigSchema = z.object({
  cwd: z.string().min(1).optional(),
  systemPrompt: z.string().optional(),
  model: z.string().optional(),
  modeId: z.string().optional(),
  route: z.enum(["default", "prismer", "omniroute"]).optional(),
  proxyProvider: z.string().min(1).optional(),
  prismerApiKeyEnv: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .optional(),
});

export type PiCoreConfig = z.infer<typeof PiCoreConfigSchema>;

export function createPiCoreAdapter(options?: PiAgentCoreClientOptions): AdapterDef {
  return {
    ...makeRuntimeAgentEngineAdapter(new PiAgentCoreClient(options), {
      resolveServiceOptions: piCoreServiceOptions,
      workspaceSchema: PiCoreConfigSchema,
    }),
    name: PI_CORE_PROVIDER,
  };
}

export const piCoreAdapter = createPiCoreAdapter();

export function piCoreServiceOptions(profile: AgentProfile) {
  const parsed = PiCoreConfigSchema.parse(profile.config);
  const wantsProxy = parsed.route === "prismer" || !!parsed.proxyProvider;
  return {
    cwd: parsed.cwd ?? process.cwd(),
    systemPrompt: parsed.systemPrompt,
    model: parsed.model,
    modeId: parsed.modeId,
    proxy: wantsProxy
      ? {
          route: parsed.route,
          proxyProvider: parsed.proxyProvider,
          prismerApiKeyEnv: parsed.prismerApiKeyEnv,
          model: parsed.model,
        }
      : undefined,
    // runtime210/09 §3.1b (C3c ruling, Path B) — pi-core opts IN to both
    // runtime210/09 seams; every other engine keeps the driver defaults
    // ('off' / no heartbeat), so their behaviour is unchanged.
    textDeltaChannel: "steps" as const,
    progressHeartbeat: true,
    // runtime210/09 §2.3 (review P1-C) — the pi-core session jail binds the
    // dispatch's materialized workdir (metadata.prismerScratchDir/prismerWorkDir)
    // over the profile cwd, so the jail lands on the repo the task actually
    // works (dispatch.ts materializes it via shouldOverrideCwdForWorkdir).
    taskCwdPriority: true,
  };
}
