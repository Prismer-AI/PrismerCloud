// OpenClaw adapter — HTTP-only client of the user's `openclaw gateway`.
//
// OpenClaw runs in its own Node process (the `openclaw` CLI). It exposes
// an OpenAI-compatible POST /v1/chat/completions endpoint when the gateway
// is started with `gateway.http.endpoints.chatCompletions.enabled = true`.
// The bootstrap script for the eng-agent container writes an openclaw.json
// that:
//   1. Configures a custom provider `prismer` pointing at the cloud LLM
//      proxy (the byte-level forwarder in src/lib/llm-proxy.ts), so the
//      sk-prismer-* key the daemon authenticates with is reused for LLM
//      egress — same trust boundary, no extra secret.
//   2. Sets `agents.defaults.model.primary` to a prismer-routed model id.
//   3. Enables the OpenAI Chat Completions HTTP endpoint on a fixed port.
//
// We then call POST /v1/chat/completions in non-streaming mode and pass
// the assistant text back as the TaskResult output.

import { z } from 'zod';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  AdapterDef,
  AdapterService,
  HealthStatus,
  TaskInput,
  TaskResult,
  ValidationResult,
} from '../contract.js';
import { categorizeDispatchError } from '../contract.js';
import { OpenClawSkillLoader } from './skill-loader.js';
import { isVersionInRange, parseVersionFromStdout } from '../version-check.js';
import { ADAPTER_KNOWN_VERSIONS } from '../known-versions.js';

/**
 * Tested-good openclaw binary version range (Release 201 v2.0.7 P1).
 *
 * The wrapper carries a 2026.4.x-specific stderr-bleed workaround
 * (see dispatch() — `stripping known stderr-bleed prefix`). The probe
 * warns when the upstream landed a fix and the workaround should be
 * revisited, and when the local CLI predates the line we tested
 * against. `health()` is best-effort: a missing `openclaw` binary does
 * not mark the adapter unavailable because long-running setups can
 * reach the gateway over HTTP without the CLI being in PATH.
 */
const OPENCLAW_MIN_VERSION = ADAPTER_KNOWN_VERSIONS.openclaw!.minVersion;
const OPENCLAW_KNOWN_GOOD = ADAPTER_KNOWN_VERSIONS.openclaw!.knownGood;

const PRISMER_ROLE_SKILL_PREFIX = 'prismer-role';

export const OpenClawProfileConfigSchema = z.object({
  /** OpenClaw chat-completions HTTP port. */
  port: z.number().int().min(1).max(65_535).default(18789),
  /** Bearer token expected by the gateway (from gateway.auth.bearerTokens). */
  apiKey: z.string().min(1),
  /**
   * Model field passed to OpenClaw's /v1/chat/completions. OpenClaw
   * intercepts this differently from a vanilla OpenAI server: the value
   * MUST be `openclaw` (or `openclaw/<agentId>`) — it picks which
   * OpenClaw agent answers, NOT the underlying LLM. The LLM is selected
   * by `agents.defaults.model.primary` in openclaw.json (e.g.
   * `prismer/us-kimi-k2.5`, set by the bootstrap).
   */
  model: z.string().min(1).default('openclaw'),
  mcpAllowlist: z.array(z.string()).nullable().optional(),
  approvalPolicy: z.enum(['strict', 'auto-low-risk', 'autonomous']).optional().default('auto-low-risk'),
  roleTemplate: z
    .object({
      mcpServers: z.array(z.object({ toolsAllowlist: z.array(z.string()).optional() }).passthrough()).optional(),
    })
    .passthrough()
    .optional(),
  skillsDir: z.string().optional(),

  /**
   * release202/03 §3.2 — when set, ensure the OpenClaw gateway's openclaw.json
   * carries a `prismer` model provider pointing at our cloud gateway, and that
   * `agents.defaults.model.primary` is the curated model below. Lets each
   * OpenClaw agent run a different curated chat model through one sk-prismer key
   * (tiered model). Undefined = leave openclaw.json untouched (legacy).
   */
  proxyProvider: z.enum(['newapi', 'deepseek']).optional(),
  /** Curated LLM model id the gateway should use (e.g. 'us-kimi-k2.6'). */
  prismerModel: z.string().optional(),
  /** Env var (in the gateway process) holding the sk-prismer-* key. */
  prismerApiKeyEnv: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .default('PRISMER_API_KEY'),
  /** openclaw.json path (default ~/.openclaw/openclaw.json or $OPENCLAW_HOME). */
  openclawConfigPath: z.string().optional(),
});

export type OpenClawProfileConfig = z.infer<typeof OpenClawProfileConfigSchema>;

// ---------------------------------------------------------------------------
// Prismer gateway provider writer (release202/03 §3.2)
// ---------------------------------------------------------------------------

interface OpenClawPrismerProvider {
  baseUrl: string; // <PRISMER_BASE_URL>/api/v1
  apiKeyEnv: string; // env-var NAME the gateway reads (kept as ${VAR} in json)
  model: string; // curated model id
}

/** Resolve the gateway base + curated model for openclaw.json, or null. */
export function resolveOpenClawPrismerProvider(
  config: OpenClawProfileConfig,
): OpenClawPrismerProvider | null {
  if (!config.proxyProvider || !config.prismerModel) return null;
  const base = process.env.PRISMER_BASE_URL?.replace(/\/+$/, '');
  if (!base) {
    process.stderr.write(
      '[openclaw-adapter] proxyProvider set but PRISMER_BASE_URL missing; leaving openclaw.json untouched\n',
    );
    return null;
  }
  return { baseUrl: `${base}/api/v1`, apiKeyEnv: config.prismerApiKeyEnv, model: config.prismerModel };
}

/** Resolve the openclaw.json path the gateway reads. */
export function resolveOpenClawConfigPath(config: OpenClawProfileConfig): string {
  if (config.openclawConfigPath) return config.openclawConfigPath;
  return join(process.env.OPENCLAW_HOME || join(homedir(), '.openclaw'), 'openclaw.json');
}

/** Tolerantly parse openclaw.json (JSON5-ish: strip // and /* *​/ comments). */
function readOpenClawConfig(jsonPath: string): Record<string, unknown> {
  if (!existsSync(jsonPath)) return {};
  try {
    const raw = readFileSync(jsonPath, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    process.stderr.write(
      `[openclaw-adapter] could not parse ${jsonPath}; merging into a fresh config\n`,
    );
    return {};
  }
}

/**
 * Merge a `prismer` model provider + set `agents.defaults.model.primary` into
 * openclaw.json, preserving the user's other config (merge, not overwrite).
 *
 * Spec (cc-switch `openclaw_config.rs` + empirically verified, §1.4):
 *  - `models.providers.prismer.{baseUrl, apiKey:"${ENV}", auth:"api-key",
 *     api:"openai-completions", models:[{id}]}` — apiKey MUST be the `${ENV}`
 *     interpolation form (a bare env name is sent verbatim → 401).
 *  - `agents.defaults.model.primary = "prismer/<model>"`.
 *
 * Returns the path written. The OpenClaw gateway must be (re)started to pick up
 * changes — it reads openclaw.json at boot.
 */
export function writeOpenClawPrismerProvider(
  jsonPath: string,
  provider: OpenClawPrismerProvider,
): string {
  const cfg = readOpenClawConfig(jsonPath);

  const models = (cfg.models && typeof cfg.models === 'object' ? cfg.models : {}) as Record<string, unknown>;
  const providers = (models.providers && typeof models.providers === 'object'
    ? models.providers
    : {}) as Record<string, unknown>;
  providers.prismer = {
    baseUrl: provider.baseUrl,
    apiKey: `\${${provider.apiKeyEnv}}`,
    auth: 'api-key',
    api: 'openai-completions',
    models: [{ id: provider.model, name: provider.model }],
  };
  models.providers = providers;
  if (typeof models.mode !== 'string') models.mode = 'merge';
  cfg.models = models;

  const agents = (cfg.agents && typeof cfg.agents === 'object' ? cfg.agents : {}) as Record<string, unknown>;
  const defaults = (agents.defaults && typeof agents.defaults === 'object'
    ? agents.defaults
    : {}) as Record<string, unknown>;
  defaults.model = { ...(typeof defaults.model === 'object' ? defaults.model : {}), primary: `prismer/${provider.model}` };
  agents.defaults = defaults;
  cfg.agents = agents;

  mkdirSync(join(jsonPath, '..'), { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return jsonPath;
}

export const openclawAdapter: AdapterDef = {
  name: 'openclaw',
  kind: 'long-running',
  capabilities: ['chat', 'code', 'multi-channel'],
  workspaceSchema: OpenClawProfileConfigSchema,

  validate(config: unknown): ValidationResult {
    const r = OpenClawProfileConfigSchema.safeParse(config);
    if (r.success) return { ok: true };
    return {
      ok: false,
      errors: r.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
    };
  },

  async ensureService(profile): Promise<AdapterService> {
    const config = OpenClawProfileConfigSchema.parse(profile.config);

    // release202/03 §3.2 — ensure openclaw.json routes the curated model through
    // our cloud gateway (tiered model). The gateway reads openclaw.json at boot,
    // so this takes effect on the next `openclaw gateway` (re)start; we write the
    // config here so setup/bootstrap doesn't have to special-case it.
    const prismerProvider = resolveOpenClawPrismerProvider(config);
    if (prismerProvider) {
      const path = resolveOpenClawConfigPath(config);
      try {
        writeOpenClawPrismerProvider(path, prismerProvider);
      } catch (err) {
        process.stderr.write(
          `[openclaw-adapter] failed to write prismer provider into ${path}: ${(err as Error).message}\n`,
        );
      }
    }

    const baseUrl = `http://127.0.0.1:${config.port}`;
    if (!(await checkHealth(baseUrl, config.apiKey))) {
      throw new Error(
        `OpenClaw gateway not reachable at ${baseUrl}. Start it with:\n  openclaw gateway --port ${config.port}`,
      );
    }
    const skillsDir = resolveOpenClawSkillsDir(profile, config);
    return new OpenClawService(baseUrl, config.apiKey, config.model, config, new OpenClawSkillLoader(skillsDir));
  },

  async health(): Promise<HealthStatus> {
    // Per-service runtime health is HTTP (see `OpenClawService.healthy`).
    // Release 201 v2.0.7 P1 additionally probes `openclaw --version` to
    // surface drift from the KNOWN_GOOD pin tracked in known-versions.ts.
    // The probe is best-effort: a missing binary still resolves to
    // available:true because long-running gateways may be reached over
    // HTTP without the CLI being installed locally.
    return new Promise<HealthStatus>((resolve) => {
      const proc = spawn('openclaw', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let stdout = '';
      proc.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      proc.on('exit', (code) => {
        if (code === 0) {
          const detected = parseVersionFromStdout(stdout);
          if (!isVersionInRange(detected, OPENCLAW_MIN_VERSION)) {
            process.stderr.write(
              `[openclaw-adapter] detected openclaw ${detected} below MIN ${OPENCLAW_MIN_VERSION}; behavior is unverified\n`,
            );
          } else if (detected !== OPENCLAW_KNOWN_GOOD && OPENCLAW_KNOWN_GOOD !== 'unknown') {
            process.stderr.write(
              `[openclaw-adapter] detected openclaw ${detected}, known-good ${OPENCLAW_KNOWN_GOOD}; minor drift OK if smoke passes\n`,
            );
          }
        }
        resolve({ available: true });
      });
      proc.on('error', () => resolve({ available: true }));
    });
  },
};

class OpenClawService implements AdapterService {
  readonly id: string;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly config: OpenClawProfileConfig,
    private readonly skillLoader: OpenClawSkillLoader,
  ) {
    this.id = baseUrl;
  }

  async healthy(): Promise<boolean> {
    return checkHealth(this.baseUrl, this.apiKey);
  }

  async dispatch(task: TaskInput): Promise<TaskResult> {
    const startedAt = Date.now();
    // v2.0 (A3) — dispatch.ts composes the profile systemPrompt + operating
    // principles into `metadata.systemPrompt`. We've always read this field,
    // so no logic change here — just inheriting the composed content.
    const systemPrompt =
      typeof task.metadata?.systemPrompt === 'string' ? task.metadata.systemPrompt : undefined;
    this.installRoleTemplateSkill();
    const skillPrompt = await this.skillLoader.loadSystemPromptFragment().catch((err) => {
      process.stderr.write(`[openclaw-adapter] failed to read skills: ${(err as Error).message}\n`);
      return undefined;
    });
    const systemContent = [systemPrompt, skillPrompt].filter(Boolean).join('\n\n');

    // ── 14b rev.3 §3.0.4 / §9 P2 — endpoint switch ─────────────────
    //
    // Pre-rev.3 we POSTed `/v1/chat/completions` with `messages[].content`
    // as a flat string. That endpoint runs through `extractTextContent`
    // (openai-http.ts:46) which strips any non-text block silently — so
    // image attachments routed through OpenClaw never reached the agent.
    //
    // OpenClaw's actual multimodal endpoint is `/v1/responses` (handler
    // in openresponses-http.ts). It natively supports `input_image`
    // (source.url or source.base64) and `input_file` (PDF auto-rendered
    // to images). Switching unconditionally is safe: text-only requests
    // are valid `input` arrays containing only `input_text`.
    const refs = task.assetRefs ?? [];
    const imageRefs = refs.filter((r) => r.mime?.startsWith('image/'));
    const fileRefs = refs.filter((r) => r.mime && !r.mime.startsWith('image/'));

    // release201/26 §13.4a P2 — re-inject IMAGES quoted from OLDER messages as
    // real input_image blocks. The agent's history holds only a `[screenshot]`
    // placeholder for the quoted turn, so a text quote line can't convey the
    // pixels; fold quote `imageAssetRefs` into imageRefs (dedup by assetId).
    const seenAssetIds = new Set(imageRefs.map((r) => r.assetId));
    for (const q of task.contextEnvelope?.quotes ?? []) {
      for (const ref of q.imageAssetRefs ?? []) {
        if (!ref.mime?.startsWith('image/') || seenAssetIds.has(ref.assetId)) continue;
        seenAssetIds.add(ref.assetId);
        imageRefs.push({ ...ref, reachable: ref.cdnUrl ? 'cdn' : 'unknown' } as (typeof imageRefs)[number]);
      }
    }

    const inputContent: Array<Record<string, unknown>> = [
      { type: 'input_text', text: task.prompt },
    ];
    for (const r of imageRefs) {
      const source = pickResponsesSource(r);
      if (!source) {
        inputContent.push({
          type: 'input_text',
          text: `[image attachment id=${r.assetId} unavailable: cdn unreachable and bytes exceeded inline cap]`,
        });
        continue;
      }
      inputContent.push({ type: 'input_image', source });
    }
    for (const r of fileRefs) {
      const source = pickResponsesSource(r);
      if (!source) {
        inputContent.push({
          type: 'input_text',
          text: `[file attachment id=${r.assetId} mime=${r.mime ?? 'unknown'} unavailable]`,
        });
        continue;
      }
      // input_file source carries an optional `filename` so OpenClaw shows
      // the human label inside the agent prompt instead of an opaque hash.
      if (r.filename && source.type === 'base64') {
        (source as Record<string, unknown>).filename = r.filename;
      }
      inputContent.push({ type: 'input_file', source });
    }

    const input = [{ type: 'message', role: 'user', content: inputContent }];

    try {
      const res = await fetch(`${this.baseUrl}/v1/responses`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          input,
          // OpenClaw `/v1/responses` accepts top-level `instructions` for
          // the system prompt — keeping it out of the user message
          // preserves cleanish channel-context separation.
          ...(systemContent ? { instructions: systemContent } : {}),
          stream: false,
        }),
        signal: task.signal,
      });
      if (!res.ok) {
        const body = (await res.text().catch(() => '')) ?? '';
        return {
          ok: false,
          error: {
            code: res.status === 401 || res.status === 403 ? 'auth_invalid' : 'adapter_dispatch_failed',
            message: `OpenClaw ${res.status}: ${body.slice(0, 400)}`,
          },
        };
      }
      const json = (await res.json()) as {
        // /v1/responses returns an `output` array of message items, each
        // with a `content` array of `output_text` blocks (OpenAI Responses
        // API shape). We concatenate all output_text.text into the
        // assistant reply string. Fallback through legacy choices[] in
        // case the deployed OpenClaw build still emits chat-style frames.
        output?: Array<{
          type?: string;
          content?: Array<{ type?: string; text?: string }>;
        }>;
        choices?: Array<{ message?: { content?: string } }>;
      };
      let output = '';
      if (Array.isArray(json.output)) {
        for (const item of json.output) {
          if (item?.type === 'message' && Array.isArray(item.content)) {
            for (const part of item.content) {
              if (part?.type === 'output_text' && typeof part.text === 'string') {
                output += part.text;
              }
            }
          }
        }
      }
      if (!output) {
        output = json.choices?.[0]?.message?.content ?? '';
      }
      // OpenClaw 2026.4.x has a bug where the embedded harness's runtime
      // error ("Cannot read properties of undefined (reading 'input')") is
      // prepended to assistant content even when the LLM itself answered
      // successfully. Strip the bleed-through so downstream consumers see
      // a clean response. Reproduces with a plain curl POST.
      //
      // Detect-then-warn-then-strip: if upstream fixes the bug, this log
      // line drops to zero and we know it's safe to remove. If the bug
      // mutates (e.g. `reading 'output'`) the regex still matches the
      // family, but if it stops matching entirely we'll see raw stack-
      // trace prefixes leak to users — easier to spot than silent strip.
      const ERR_PREFIX_RE = /^Cannot read properties of undefined \(reading '[^']+'\)\s*\n+/;
      if (ERR_PREFIX_RE.test(output)) {
        process.stderr.write(
          `[openclaw-adapter] stripping known stderr-bleed prefix from chat output (OpenClaw 2026.4.x bug)\n`,
        );
        output = output.replace(ERR_PREFIX_RE, '');
      }
      return {
        ok: true,
        output,
        metrics: { durationMs: Date.now() - startedAt },
      };
    } catch (err) {
      // v2.0 (A6) — shared categorizer; was 7 lines of duplicated boilerplate.
      return categorizeDispatchError(err, task.signal);
    }
  }

  private installRoleTemplateSkill(): void {
    const roleTemplate = readPlainRecord(this.config.roleTemplate);
    const openclawConfig = readPlainRecord(roleTemplate?.openclawConfig);
    const agents = readNonEmptyString(openclawConfig?.agents);
    if (!agents) return;

    const slug = sanitizeRoleSkillSlug(readNonEmptyString(roleTemplate?.slug) ?? 'template');
    const skillName = `${PRISMER_ROLE_SKILL_PREFIX}-${slug}`;
    const content = renderRoleTemplateSkill(skillName, agents, roleTemplate);
    try {
      const skillDir = join(this.skillLoader.getSkillsRoot(), skillName);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), content, 'utf8');
    } catch (err) {
      process.stderr.write(
        `[openclaw-adapter] failed to install role-template skill ${skillName}: ${(err as Error).message}\n`,
      );
    }
  }
}

function readPlainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sanitizeRoleSkillSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'template'
  );
}

function renderRoleTemplateSkill(
  skillName: string,
  agents: string,
  roleTemplate: Record<string, unknown> | null,
): string {
  const mcpServers = Array.isArray(roleTemplate?.mcpServers) ? roleTemplate.mcpServers : [];
  const tools = new Set<string>();
  for (const server of mcpServers) {
    const rec = readPlainRecord(server);
    const allowlist = Array.isArray(rec?.toolsAllowlist) ? rec.toolsAllowlist : [];
    for (const tool of allowlist) {
      if (typeof tool === 'string' && tool.trim()) tools.add(tool.trim());
    }
  }
  const allowedTools = [...tools].join(' ');
  const roleTemplateSlug = JSON.stringify(readNonEmptyString(roleTemplate?.slug) ?? null);
  return `---
name: ${skillName}
description: Role-template operating playbook projected from Prismer RoleTemplate.
${allowedTools ? `allowed-tools: ${allowedTools}\n` : ''}metadata:
  prismer:
    source: role-template
    roleTemplateSlug: ${roleTemplateSlug}
---

# Role Template Playbook

${agents.trim()}
`;
}

/**
 * 14b rev.3 §3.0.4 — pick the right `source` shape for an OpenClaw
 * `/v1/responses` `input_image` / `input_file` block. Returns null when
 * neither cdnUrl reachability nor base64 inline succeeded — caller
 * substitutes a text fallback breadcrumb.
 */
function pickResponsesSource(
  ref: { cdnUrl?: string; base64?: string; mime: string | null; reachable?: 'cdn' | 'base64' | 'unknown' },
): { type: 'url'; url: string } | { type: 'base64'; data: string; media_type: string } | null {
  if (ref.reachable === 'cdn' && ref.cdnUrl) {
    return { type: 'url', url: ref.cdnUrl };
  }
  if (ref.base64) {
    return {
      type: 'base64',
      data: ref.base64,
      media_type: ref.mime ?? 'application/octet-stream',
    };
  }
  // Last-resort: pass cdnUrl even if probe failed — some deployments place
  // the cloud and OpenClaw on the same internal network, in which case the
  // probe (run from the daemon) may misclassify.
  if (ref.cdnUrl) {
    return { type: 'url', url: ref.cdnUrl };
  }
  return null;
}

export function getOpenClawSkillsDir(profile: { id: string; agentUsername?: string; config: Record<string, unknown> }): string {
  const config = OpenClawProfileConfigSchema.parse(profile.config);
  return resolveOpenClawSkillsDir(profile, config);
}

function resolveOpenClawSkillsDir(
  profile: { id: string; agentUsername?: string },
  config: OpenClawProfileConfig,
): string {
  if (config.skillsDir) return config.skillsDir;
  const name = profile.agentUsername || profile.id.slice(0, 8);
  return join(process.env.OPENCLAW_HOME || join(homedir(), '.openclaw'), 'profiles', name, 'skills');
}

async function checkHealth(baseUrl: string, apiKey: string): Promise<boolean> {
  // OpenClaw exposes /health (no auth required for liveness). Bearer is
  // attached only because some deployments enforce it on every path.
  try {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
