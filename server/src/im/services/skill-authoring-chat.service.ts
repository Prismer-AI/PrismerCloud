/**
 * Prismer IM — Skill Authoring Chat (release201/24 §Phase1a, Path B).
 *
 * The conversational wizard's spec-gathering brain. Instead of pausing a
 * dispatched authoring task mid-run to ask the user questions (Path A — no
 * mid-task clarification channel exists, see release201/24 §3), the wizard
 * FRONT-LOADS the clarifying Q&A here: this endpoint drives a short
 * conversation that converges an {@link AuthoringSpec}, and only once the spec
 * is complete does the wizard fire a single `skill-authoring` IMTask via the
 * existing `/skills/authoring-requests` dispatch (fire-and-forget + SSE).
 *
 * Stateless: the client holds the message history and replays it each turn.
 * Zero schema change — nothing is persisted here.
 *
 * LLM call reuses the OpenAI-compatible `chat/completions` pattern from
 * `memory-extract.ts` (env-configured base/key/model).
 */

const LOG = '[SkillAuthoringChat]';

export type AuthoringSourceKind = 'inline-spec' | 'doc-url' | 'code-source' | 'service-endpoint';
export type AuthoringScope = 'private' | 'workspace' | 'public';

export interface AuthoringSampleTask {
  input: string;
  acceptanceCriteria: string[];
}

/** The converged intake spec the authoring agent receives (release201/24 §2.1). */
export interface AuthoringSpec {
  slug?: string;
  name?: string;
  triggers?: string[];
  inputs?: string;
  outputs?: string;
  sourceKind?: AuthoringSourceKind;
  sourceRefs?: string[];
  scope?: AuthoringScope;
  acceptanceCriteria?: string[];
  sampleTasks?: AuthoringSampleTask[];
}

/** A structured decision point surfaced to the user as a choice card. */
export interface AuthoringChatDecision {
  key: string;
  label: string;
  options: Array<{ value: string; label: string; hint?: string }>;
  multiple?: boolean;
}

export interface AuthoringChatTurn {
  reply: string;
  spec: AuthoringSpec;
  decisions: AuthoringChatDecision[];
  ready: boolean;
}

export interface AuthoringChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AuthoringChatInput {
  messages: AuthoringChatMessage[];
  workspaceId: string;
  specSoFar?: AuthoringSpec;
}

/** Injectable LLM caller so unit tests can drive deterministic turns. */
export type AuthoringChatLLM = (req: {
  system: string;
  messages: AuthoringChatMessage[];
}) => Promise<string>;

export interface AuthoringChatDeps {
  llm?: AuthoringChatLLM;
}

// release201/24 — mirror memory-extract.ts:getLLMConfig (OpenAI-compatible).
function getLLMConfig() {
  const apiKey = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || process.env.PRISMER_API_KEY || '';
  const apiBase =
    process.env.OPENAI_BASE_URL ||
    process.env.OPENAI_API_BASE_URL ||
    process.env.LLM_API_BASE ||
    'http://localhost:3000/api/v1';
  const model =
    process.env.LLM_AUTHORING_MODEL ||
    process.env.DISTILL_MODEL ||
    process.env.DEFAULT_MODEL ||
    'gpt-4o-mini';
  return { apiKey, apiBase, model };
}

const SYSTEM_PROMPT = `You are the Prismer skill-authoring intake assistant. Through a SHORT conversation (aim for 2-4 turns) you gather a complete spec so an authoring agent can build a Prismer skill draft. The canonical path is release201/24 scenario 1: an API doc / OpenAPI / URL becomes a skill with a runnable call script and real eval tests.

Each turn, reply with a SINGLE JSON object ONLY (no prose, no markdown fences) of this exact shape:
{
  "reply": "your short conversational message to the user",
  "spec": {
    "slug": "kebab-case-slug",
    "name": "Human Name",
    "triggers": ["phrase that should invoke the skill"],
    "inputs": "what the skill takes",
    "outputs": "what it returns",
    "sourceKind": "inline-spec" | "doc-url" | "code-source" | "service-endpoint",
    "sourceRefs": ["url or path"],
    "scope": "private" | "workspace" | "public",
    "acceptanceCriteria": ["substring/regex the dispatch output must contain"],
    "sampleTasks": [{ "input": "natural-language prompt", "acceptanceCriteria": ["..."] }]
  },
  "decisions": [
    { "key": "sourceKind", "label": "Where does this skill come from?",
      "options": [{ "value": "doc-url", "label": "API doc / URL", "hint": "OpenAPI, README" }], "multiple": false }
  ],
  "ready": false
}

Rules:
- Carry forward and refine the spec every turn — return the FULL spec object, not a delta.
- Use "decisions" for the few high-signal structured choices (sourceKind, scope, acceptance strategy). Leave it [] when free text is more natural. Never ask more than 2 decisions in one turn.
- Derive acceptanceCriteria from the source material the user describes (required response fields, status codes, schema keys). If unknown, propose a minimal criterion (exits 0 + non-empty JSON + a field-presence check). NEVER leave a placeholder like "works correctly".
- Set "ready": true ONLY when the spec has: slug, name, >=1 trigger, sourceKind, scope, and >=1 sampleTask whose acceptanceCriteria are concrete (or a non-empty top-level acceptanceCriteria). When ready, "reply" should summarize what will be dispatched.
- Keep replies concise and friendly. Do not invent sources the user did not give.`;

async function defaultLLM(req: { system: string; messages: AuthoringChatMessage[] }): Promise<string> {
  const { apiKey, apiBase, model } = getLLMConfig();
  if (!apiKey) {
    throw new Error('no_llm_api_key');
  }
  const response = await fetch(`${apiBase}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: req.system }, ...req.messages],
      temperature: 0.4,
      max_tokens: 1200,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`llm_http_${response.status}`);
  }
  const json = (await response.json()) as any;
  return json.choices?.[0]?.message?.content || '';
}

/** Extract the first balanced JSON object from a model response. */
function extractJsonObject(text: string): any | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const SOURCE_KINDS: AuthoringSourceKind[] = ['inline-spec', 'doc-url', 'code-source', 'service-endpoint'];
const SCOPES: AuthoringScope[] = ['private', 'workspace', 'public'];

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : [];
}

/** Coerce raw model output into a typed, validated {@link AuthoringSpec}. */
function normalizeSpec(raw: any): AuthoringSpec {
  const spec: AuthoringSpec = {};
  if (typeof raw?.slug === 'string' && raw.slug.trim()) spec.slug = raw.slug.trim();
  if (typeof raw?.name === 'string' && raw.name.trim()) spec.name = raw.name.trim();
  if (typeof raw?.inputs === 'string' && raw.inputs.trim()) spec.inputs = raw.inputs.trim();
  if (typeof raw?.outputs === 'string' && raw.outputs.trim()) spec.outputs = raw.outputs.trim();
  const triggers = asStringArray(raw?.triggers);
  if (triggers.length) spec.triggers = triggers;
  if (SOURCE_KINDS.includes(raw?.sourceKind)) spec.sourceKind = raw.sourceKind;
  const refs = asStringArray(raw?.sourceRefs);
  if (refs.length) spec.sourceRefs = refs;
  if (SCOPES.includes(raw?.scope)) spec.scope = raw.scope;
  const ac = asStringArray(raw?.acceptanceCriteria);
  if (ac.length) spec.acceptanceCriteria = ac;
  if (Array.isArray(raw?.sampleTasks)) {
    const tasks = raw.sampleTasks
      .map((t: any): AuthoringSampleTask | null => {
        const input = typeof t?.input === 'string' ? t.input.trim() : '';
        const criteria = asStringArray(t?.acceptanceCriteria);
        if (!input) return null;
        return { input, acceptanceCriteria: criteria };
      })
      .filter((t: AuthoringSampleTask | null): t is AuthoringSampleTask => t !== null);
    if (tasks.length) spec.sampleTasks = tasks;
  }
  return spec;
}

function normalizeDecisions(raw: any): AuthoringChatDecision[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((d: any): AuthoringChatDecision | null => {
      if (typeof d?.key !== 'string' || typeof d?.label !== 'string') return null;
      const options = Array.isArray(d?.options)
        ? d.options
            .map((o: any) =>
              typeof o?.value === 'string' && typeof o?.label === 'string'
                ? { value: o.value, label: o.label, ...(typeof o.hint === 'string' ? { hint: o.hint } : {}) }
                : null,
            )
            .filter(Boolean)
        : [];
      if (!options.length) return null;
      return { key: d.key, label: d.label, options, multiple: d.multiple === true };
    })
    .filter((d: AuthoringChatDecision | null): d is AuthoringChatDecision => d !== null);
}

/** True when the spec is concrete enough to dispatch (mirrors the prompt's ready rule). */
export function isSpecReady(spec: AuthoringSpec): boolean {
  if (!spec.slug || !spec.name || !spec.sourceKind || !spec.scope) return false;
  if (!spec.triggers || spec.triggers.length === 0) return false;
  const hasTopAcceptance = (spec.acceptanceCriteria?.length ?? 0) > 0;
  const hasSampleAcceptance = (spec.sampleTasks ?? []).some((t) => t.acceptanceCriteria.length > 0);
  return hasTopAcceptance || hasSampleAcceptance;
}

/**
 * Run one turn of the authoring intake conversation. Returns the assistant's
 * reply, the (full) converged spec so far, any structured decisions to surface,
 * and whether the spec is ready to dispatch. We trust the model's `ready` only
 * when {@link isSpecReady} also agrees, so a missing field never slips through.
 */
export async function runAuthoringChat(
  input: AuthoringChatInput,
  deps: AuthoringChatDeps = {},
): Promise<AuthoringChatTurn> {
  const llm = deps.llm ?? defaultLLM;
  const messages = [...input.messages];
  if (input.specSoFar && Object.keys(input.specSoFar).length > 0) {
    messages.unshift({
      role: 'assistant',
      content: `(spec so far: ${JSON.stringify(input.specSoFar)})`,
    });
  }

  let text: string;
  try {
    text = await llm({ system: SYSTEM_PROMPT, messages });
  } catch (err) {
    console.warn(`${LOG} llm call failed: ${(err as Error).message}`);
    throw err;
  }

  const parsed = extractJsonObject(text);
  if (!parsed) {
    // Degrade gracefully: surface the raw text as a reply, no spec advance.
    return {
      reply: text.trim() || 'Sorry, I had trouble there — could you rephrase what the skill should do?',
      spec: input.specSoFar ?? {},
      decisions: [],
      ready: false,
    };
  }

  const spec = normalizeSpec(parsed.spec ?? {});
  const ready = parsed.ready === true && isSpecReady(spec);
  return {
    reply: typeof parsed.reply === 'string' ? parsed.reply : '',
    spec,
    decisions: normalizeDecisions(parsed.decisions),
    ready,
  };
}
