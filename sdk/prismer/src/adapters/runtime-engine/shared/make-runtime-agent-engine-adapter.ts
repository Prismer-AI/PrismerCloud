import { z } from "zod";
import type {
  AdapterDef,
  AdapterService,
  AgentProfile,
  HealthStatus,
  TaskInput,
  TaskResult,
  ValidationResult,
} from "../../contract.js";
import type {
  AgentCapabilityFlags,
  RuntimeAgentEngine,
  RuntimeAgentEngineMode,
  RuntimeAgentEngineSlashCommand,
} from "./agent-engine-types.js";
import {
  CodeAgentDriver,
  type CodeAgentDriverOptions,
} from "../../coding/shared/code-agent-driver.js";

const MODULE = "[RuntimeAgentEngineAdapter]";

const RuntimeAgentEngineProfileSchema = z.object({
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

export type RuntimeAgentEngineDriverOptions = CodeAgentDriverOptions;

function capabilitiesFromFlags(provider: string, flags: AgentCapabilityFlags): string[] {
  const tags = new Set<string>(["runtime-engine", provider]);
  if (flags.supportsToolInvocations) tags.add("tools");
  if (flags.supportsMcpServers) tags.add("mcp");
  if (flags.supportsStreaming) tags.add("streaming");
  if (flags.supportsRewindConversation || flags.supportsRewindFiles || flags.supportsRewindBoth) {
    tags.add("rewind");
  }
  return [...tags];
}

export interface MakeRuntimeAgentEngineAdapterOptions {
  /**
   * Optional override for how a profile config is turned into runtime engine
   * service options. Defaults to a cwd fallback for desktop onboarding.
   */
  resolveServiceOptions?: (profile: AgentProfile) => RuntimeAgentEngineDriverOptions;
  /**
   * Optional engine-specific profile schema. Engines with gateway-specific
   * config (pi-core) supply their own so there is a single schema owner per
   * engine; the built-in schema only serves future engines with no extra
   * config surface.
   */
  workspaceSchema?: z.ZodSchema;
}

class RuntimeAgentEngineDriver implements AdapterService {
  readonly id: string;

  constructor(
    provider: string,
    private readonly delegate: CodeAgentDriver,
  ) {
    this.id = `runtime-engine:${provider}`;
  }

  dispatch(task: TaskInput): Promise<TaskResult> {
    return this.delegate.dispatch(task);
  }

  healthy(): Promise<boolean> {
    return this.delegate.healthy();
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }

  revert(input: { messageId: string; scope?: "conversation" | "files" | "both" }): Promise<void> {
    return this.delegate.revert(input);
  }

  setModel(modelId: string): Promise<void> {
    return this.delegate.setModel(modelId);
  }

  listModes(): Promise<RuntimeAgentEngineMode[]> {
    return this.delegate.listModes();
  }

  listCommands(): Promise<RuntimeAgentEngineSlashCommand[]> {
    return this.delegate.listCommands();
  }
}

/**
 * Build an AdapterDef for an in-runtime agent engine.
 *
 * The current implementation intentionally reuses CodeAgentDriver as the
 * generic AgentSession dispatcher so runtime-engine adapters keep existing
 * timeline, session reuse, durability, and control-plane semantics. That driver
 * reuse is an implementation detail; callers depend on RuntimeAgentEngine here.
 */
export function makeRuntimeAgentEngineAdapter(
  engine: RuntimeAgentEngine,
  options?: MakeRuntimeAgentEngineAdapterOptions,
): AdapterDef {
  const provider = engine.provider;
  const flags = engine.capabilities;
  const schema = options?.workspaceSchema ?? RuntimeAgentEngineProfileSchema;

  const resolveServiceOptions =
    options?.resolveServiceOptions ??
    ((profile: AgentProfile): RuntimeAgentEngineDriverOptions => {
      const parsed = RuntimeAgentEngineProfileSchema.parse(profile.config);
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
      };
    });

  return {
    name: provider,
    kind: "long-running",
    capabilities: capabilitiesFromFlags(provider, flags),
    capabilityFlags: flags,
    workspaceSchema: schema,

    async ensureService(profile: AgentProfile): Promise<AdapterService> {
      const opts = resolveServiceOptions(profile);
      console.log(`${MODULE} ensureService provider=${provider} cwd=${opts.cwd}`);
      return new RuntimeAgentEngineDriver(provider, new CodeAgentDriver(engine, opts));
    },

    validate(config: unknown): ValidationResult {
      const result = schema.safeParse(config);
      if (result.success) return { ok: true };
      return {
        ok: false,
        errors: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      };
    },

    async health(): Promise<HealthStatus> {
      try {
        const available = await engine.isAvailable();
        return available
          ? { available: true }
          : { available: false, reason: `${provider} runtime engine unavailable` };
      } catch (err) {
        return {
          available: false,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
