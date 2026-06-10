/**
 * Skill Draft Service — release201/07 skill-authoring engine
 *
 * Independent path from `skill.service.ts:create` (which produces status=active
 * catalog rows). `createDraft` accepts manifest v1 (SKILL.md + skill.json +
 * optional scripts/refs/assets) from an authoring agent, runs 7 validation
 * gates, persists as `IMSkill` row with `status='draft'`, and triggers a
 * `capability='skill-review'` IMTask assigned to the workspace owner.
 *
 * Draft rows are excluded from:
 *   • /api/im/skills/search (service.ts:_fulltextSearch + search() WHERE clauses)
 *   • POST /api/im/skills/:id/install (agent-skill.service.ts:installSkillToAgent rejects)
 *   • daemon skill-sync.ts (GET /skills/installed already filters status!='draft')
 *
 * Design: docs/release201/07-skill-authoring-engine.md §2 (esp. §2.5 row format
 * + §2.6 skill.json mapping + §2.7 7 validation gates + §2.8 service flow).
 */

import prisma from '../db';
import { buildManifest, computeManifestRevision, type ManifestFile, type ManifestFileInput } from '../skills/manifest';
import { parseFrontmatter } from '../skills/frontmatter';
import { metricEmit } from './metric.service';
import { getTaskAcceptanceService } from './task-acceptance.service';
import type { SkillLifecycleService } from './skill-lifecycle.service';
import type { ConversationService } from './conversation.service';

const LOG = '[SkillDraftService]';

// Hard limits — match release201/07 §0.2.2 / §0.2.3.
export const DRAFT_TOTAL_SIZE_LIMIT_BYTES = 5 * 1024 * 1024; // 5 MB
const SLUG_REGEX = /^[a-z][a-z0-9-]*$/;
const NAME_REGEX = /^[a-z][a-z0-9-]*$/;
const DESCRIPTION_MIN_CHARS = 50;
const SKILL_MD_MAX_LINES = 500;

// release201/07 §2.7 gate-7 — quick sandbox smoke timeout. Bound shorter than
// a full lifecycle eval (which has its own §3.2 timeout) so a fire-and-forget
// smoke can't hold the queued IMSkillEvalRun row open indefinitely.
const GATE7_SMOKE_TIMEOUT_MS = 60_000;
const GATE7_SMOKE_ALLOWLIST_BUILTINS = ['tasks', 'memory'];

// ─── Input / output types ──────────────────────────────────────

export interface SkillDraftManifestFileInput {
  path: string;
  /** Either content (utf-8 text) or contentBase64 (binary). */
  content?: string;
  contentBase64?: string;
}

export interface SkillJsonInput {
  schemaVersion: 1;
  slug: string;
  name: string;
  description: string;
  category: string;
  version: string;
  license: string;
  compatibility: Array<'prismer-sdk' | 'hermes' | 'openclaw' | 'claude-code' | 'codex'>;
  runtime: {
    kind: 'text-workflow' | 'inline-script' | 'http-endpoint' | 'mcp-tool';
    executableJson?: Record<string, unknown>;
    requires: {
      env?: string[];
      bins?: string[];
      python?: string[];
      node?: string[];
      capabilities?: string[];
    };
  };
  inputs: Array<{ name: string; type: string; required: boolean; description?: string }>;
  outputs: Array<{ name: string; type: string; required: boolean; description?: string }>;
  sampleTasks: Array<{
    title: string;
    prompt: string;
    expectedArtifacts?: string[];
    acceptanceCriteria: string[];
  }>;
  security: {
    dataAccess: Array<'workspace-assets' | 'memory' | 'external-network' | 'secrets' | 'filesystem'>;
    humanApprovalRequiredFor: string[];
  };
  provenance: {
    sourceKind: 'inline-spec' | 'doc-url' | 'code-source' | 'service-endpoint';
    sourceRefs: string[];
    authoredBy: string;
    authoredAt: string;
  };
  metadata?: Record<string, unknown>;
}

export interface CreateDraftInput {
  slug: string;
  name: string;
  description: string;
  workspaceId: string;
  ownerAgentId: string;
  files: SkillDraftManifestFileInput[];
  metadata?: { authoring?: Record<string, unknown> };
}

export interface PatchDraftFileOp {
  path: string;
  op: 'add' | 'update' | 'delete';
  content?: string;
  contentBase64?: string;
}

export interface PatchDraftInput {
  files: PatchDraftFileOp[];
  reason?: string;
}

export interface RegenerateDraftInput {
  reason: string;
  newSources?: Array<{ kind: string; ref: string }>;
  /**
   * release201/24 §Phase2 — failed eval cases that motivated the regenerate.
   * Forwarded to the authoring agent's rewrite task so it knows what to fix.
   */
  failedCases?: Array<{ id: string; error?: string }>;
}

export interface ValidationWarning {
  gate: string;
  message: string;
}

export interface CreateDraftResult {
  id: string;
  slug: string;
  manifestRevision: string;
  reviewTaskId: string | null;
  validationWarnings: ValidationWarning[];
}

export class SkillDraftError extends Error {
  statusCode: number;
  gate?: string;
  constructor(message: string, statusCode: number, gate?: string) {
    super(message);
    this.statusCode = statusCode;
    this.gate = gate;
  }
}

// ─── Helpers ──────────────────────────────────────────────────

function decodeFile(input: SkillDraftManifestFileInput): Buffer {
  if (input.contentBase64 !== undefined) {
    return Buffer.from(input.contentBase64, 'base64');
  }
  if (input.content !== undefined) {
    return Buffer.from(input.content, 'utf8');
  }
  throw new SkillDraftError(`file ${input.path}: missing content or contentBase64`, 400, 'package');
}

function totalSize(files: ManifestFile[]): number {
  return files.reduce((sum, f) => sum + (f.size || 0), 0);
}

// ─── 7 validation gates ──────────────────────────────────────

/** Gate 1: manifest — files[] complete, merkle reproducible. */
function gateManifest(files: ManifestFile[], expectedRevision: string): void {
  if (files.length === 0) {
    throw new SkillDraftError('manifest must contain at least 1 file', 400, 'manifest');
  }
  const recomputed = computeManifestRevision(files.map((f) => ({ path: f.path, sha256: f.sha256 })));
  if (recomputed !== expectedRevision) {
    throw new SkillDraftError(
      `manifest revision mismatch: expected ${expectedRevision}, recomputed ${recomputed}`,
      400,
      'manifest',
    );
  }
}

/** Gate 2: frontmatter — SKILL.md YAML parses, name + description pass spec. */
function gateFrontmatter(skillMdContent: string): {
  warnings: ValidationWarning[];
  fmName?: string;
  fmDescription?: string;
  fmLicense?: string;
} {
  const parsed = parseFrontmatter(skillMdContent);
  if (parsed.errors.length > 0) {
    throw new SkillDraftError(`frontmatter parse failed: ${parsed.errors.join('; ')}`, 400, 'frontmatter');
  }
  if (!parsed.fm.name) {
    throw new SkillDraftError('frontmatter must declare `name`', 400, 'frontmatter');
  }
  if (!parsed.fm.description) {
    throw new SkillDraftError('frontmatter must declare `description`', 400, 'frontmatter');
  }
  if (parsed.fm.description.length < DESCRIPTION_MIN_CHARS) {
    throw new SkillDraftError(
      `frontmatter description must be ≥ ${DESCRIPTION_MIN_CHARS} chars (got ${parsed.fm.description.length})`,
      400,
      'frontmatter',
    );
  }
  const warnings: ValidationWarning[] = [];
  if (!parsed.fm.license) {
    warnings.push({ gate: 'frontmatter', message: 'license missing; defaults to MIT' });
  }
  // SKILL.md body line count check (≤ 500 lines, progressive disclosure)
  const bodyLineCount = parsed.body.split('\n').length;
  if (bodyLineCount > SKILL_MD_MAX_LINES) {
    warnings.push({
      gate: 'frontmatter',
      message: `SKILL.md body is ${bodyLineCount} lines; recommend ≤ ${SKILL_MD_MAX_LINES} (progressive disclosure)`,
    });
  }
  return {
    warnings,
    fmName: parsed.fm.name,
    fmDescription: parsed.fm.description,
    fmLicense: parsed.fm.license,
  };
}

/** Gate 3: package — SKILL.md is files[0], skill.json is files[1]. */
function gatePackage(files: ManifestFile[]): { skillJson: SkillJsonInput; skillMdContent: string } {
  if (files[0]?.path !== 'SKILL.md') {
    throw new SkillDraftError(
      `files[0].path must equal 'SKILL.md' (got '${files[0]?.path ?? '<missing>'}')`,
      400,
      'package',
    );
  }
  if (files[1]?.path !== 'skill.json') {
    throw new SkillDraftError(
      `files[1].path must equal 'skill.json' (got '${files[1]?.path ?? '<missing>'}')`,
      400,
      'package',
    );
  }
  // Decode SKILL.md content
  const skillMdContent = files[0].content ? Buffer.from(files[0].content, 'base64').toString('utf8') : '';
  // Decode skill.json content
  const skillJsonText = files[1].content ? Buffer.from(files[1].content, 'base64').toString('utf8') : '';
  let skillJson: SkillJsonInput;
  try {
    skillJson = JSON.parse(skillJsonText);
  } catch (err) {
    throw new SkillDraftError(`skill.json: invalid JSON — ${(err as Error).message}`, 400, 'package');
  }
  if (skillJson.schemaVersion !== 1) {
    throw new SkillDraftError(`skill.json.schemaVersion must be 1 (got ${skillJson.schemaVersion})`, 400, 'package');
  }
  if (!NAME_REGEX.test(skillJson.slug)) {
    throw new SkillDraftError(`skill.json.slug "${skillJson.slug}" must match /^[a-z][a-z0-9-]*$/`, 400, 'package');
  }
  return { skillJson, skillMdContent };
}

/** Gate 4: requires — runtime.requires declared explicitly. */
function gateRequires(skillJson: SkillJsonInput): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];
  const r = skillJson.runtime?.requires ?? {};
  const hasAny = Boolean(
    (r.env && r.env.length > 0) ||
    (r.bins && r.bins.length > 0) ||
    (r.python && r.python.length > 0) ||
    (r.node && r.node.length > 0) ||
    (r.capabilities && r.capabilities.length > 0),
  );
  if (!hasAny) {
    warnings.push({
      gate: 'requires',
      message: 'runtime.requires is empty; declare env/bins/python/node/capabilities explicitly when applicable',
    });
  }
  return warnings;
}

/** Gate 5: security — dataAccess non-empty, sensitive scopes require approval declaration. */
function gateSecurity(skillJson: SkillJsonInput): void {
  const dataAccess = skillJson.security?.dataAccess ?? [];
  if (dataAccess.length === 0) {
    throw new SkillDraftError(
      'security.dataAccess must be non-empty (declare workspace-assets / memory / external-network / secrets / filesystem)',
      400,
      'security',
    );
  }
  const sensitive = dataAccess.filter((s) => s === 'external-network' || s === 'secrets' || s === 'filesystem');
  const approvals = skillJson.security?.humanApprovalRequiredFor ?? [];
  if (sensitive.length > 0 && approvals.length === 0) {
    throw new SkillDraftError(
      `security.dataAccess contains sensitive scopes (${sensitive.join(', ')}); humanApprovalRequiredFor must be non-empty`,
      400,
      'security',
    );
  }
}

/** Gate 6: sample — at least 1 sampleTask with at least 1 acceptanceCriteria (warn only at draft stage). */
function gateSample(skillJson: SkillJsonInput): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];
  const samples = skillJson.sampleTasks ?? [];
  if (samples.length === 0) {
    warnings.push({
      gate: 'sample',
      message: 'no sampleTasks; required before lifecycle eval (release201/08)',
    });
    return warnings;
  }
  for (let i = 0; i < samples.length; i++) {
    if (!samples[i].acceptanceCriteria || samples[i].acceptanceCriteria.length === 0) {
      warnings.push({
        gate: 'sample',
        message: `sampleTasks[${i}] has no acceptanceCriteria; required before lifecycle eval`,
      });
    }
  }
  return warnings;
}

// Gate 7 (runtime) — fire-and-forget background sandbox smoke. Runs after
// createDraft persists the IMSkill row so it never blocks the synchronous
// 200 OK response (release201/07 §2.7: runtime gate is warn-level, not
// blocking). The smoke picks sampleTasks[0] from skill.json, enqueues an
// IMSkillEvalRun (status='queued'), emits `skill.authoring.smoke_started` +
// the canonical `skill.authoring.validation_completed` event including the
// gate-7 outcome, and appends the result to metadata.validationWarnings.
//
// Execution itself is handled by the daemon's EvalSessionRunner (release201/08
// §3.2) when it pulls the queued IMSkillEvalRun row. When no daemon is
// available (cloud-only dev / test env) the smoke is recorded as a
// `queued_no_runner` warning — the draft still ships, the warning surfaces
// in Studio Authoring for the reviewer.
//
// Detail: SkillDraftService.runGate7Smoke (below).

// ─── Service ──────────────────────────────────────────────────

export class SkillDraftService {
  /**
   * release201/08 §10.6 / S21 — optional deps injected from api/routes.ts.
   *  • `lifecycle` lets createDraft / patchDraft fan out the
   *    `skill.authoring.*` SSE events without coupling to SyncService.
   *  • `conversations` lets createDraft tag the originating authoring agent
   *    conversation with `metadata.skillDev.role='dev'` (4 session role
   *    plumbing — §3.0).
   * Both are best-effort — unit tests that only exercise gate logic may
   * omit them.
   */
  constructor(
    private readonly deps: {
      lifecycle?: SkillLifecycleService;
      conversations?: ConversationService;
    } = {},
  ) {}

  /**
   * Create a new draft skill. Returns 201-ready { id, slug, manifestRevision,
   * reviewTaskId, validationWarnings }. Blocking gate failures throw
   * SkillDraftError with statusCode=400.
   */
  async createDraft(input: CreateDraftInput): Promise<CreateDraftResult> {
    // Step 0: pre-flight input shape
    if (!input.slug || !SLUG_REGEX.test(input.slug)) {
      throw new SkillDraftError(`slug must match /^[a-z][a-z0-9-]*$/ (got "${input.slug ?? ''}")`, 400, 'package');
    }
    if (!input.name || !input.description) {
      throw new SkillDraftError('name and description are required', 400, 'package');
    }
    if (!input.workspaceId || !input.ownerAgentId) {
      throw new SkillDraftError('workspaceId and ownerAgentId are required', 400, 'package');
    }
    if (!Array.isArray(input.files) || input.files.length < 2) {
      throw new SkillDraftError('files[] must contain at least SKILL.md and skill.json', 400, 'package');
    }

    // Step 1: slug global uniqueness — draft / active / pending_review / deprecated cannot share slug
    const conflict = await prisma.iMSkill.findUnique({
      where: { slug: input.slug },
      select: { id: true, status: true },
    });
    if (conflict) {
      // release201/08 §10.7 — `duplicate_or_reuse` failure kind. Emit before
      // throwing so reviewer surface lights up the "found similar skill"
      // card immediately. The conflicting row IS the row we need to point
      // the UI at (Install / Fork choice happens on the conflict row's
      // skillId).
      if (this.deps.lifecycle) {
        await this.deps.lifecycle.emitAuthoringFailed(
          conflict.id,
          'duplicate_or_reuse',
          'intake',
          `slug "${input.slug}" already exists (status=${conflict.status})`,
          'warning',
        );
      }
      throw new SkillDraftError(`slug "${input.slug}" already exists (status=${conflict.status})`, 409, 'package');
    }

    // Step 2: ownerAgentId must be a member (via agent-profile) of workspaceId
    const profile = await prisma.iMAgentProfile.findFirst({
      where: { agentImUserId: input.ownerAgentId, workspaceId: input.workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!profile) {
      // also accept the workspace owner themselves as ownerAgentId
      const workspaceOwned = await prisma.iMWorkspace.findFirst({
        where: { id: input.workspaceId, deletedAt: null, ownerImUserId: input.ownerAgentId },
        select: { id: true },
      });
      if (!workspaceOwned) {
        throw new SkillDraftError(
          `ownerAgentId ${input.ownerAgentId} does not belong to workspace ${input.workspaceId}`,
          403,
          'package',
        );
      }
    }

    // Step 3: build manifest from input files
    const manifestInputs: ManifestFileInput[] = input.files.map((f) => ({
      path: f.path,
      bytes: decodeFile(f),
    }));
    const manifest = await buildManifest(manifestInputs);

    // Step 4: total size limit
    const size = totalSize(manifest.files);
    if (size > DRAFT_TOTAL_SIZE_LIMIT_BYTES) {
      throw new SkillDraftError(
        `manifest total size ${size} bytes exceeds limit ${DRAFT_TOTAL_SIZE_LIMIT_BYTES}`,
        413,
        'package',
      );
    }

    // Step 5: 7 validation gates — gates 1-6 run synchronously here;
    // gate-7 (runtime sandbox smoke) is fire-and-forget background work
    // scheduled at Step 10 via runGate7Smoke (release201/07 §2.7 footnote).
    const warnings: ValidationWarning[] = [];

    // Gate 1 — manifest
    gateManifest(manifest.files, manifest.revision);

    // Gate 3 — package (SKILL.md is files[0], skill.json is files[1])
    const { skillJson, skillMdContent } = gatePackage(manifest.files);

    // Cross-check: skill.json.slug / name / description must match top-level
    if (skillJson.slug !== input.slug) {
      throw new SkillDraftError(
        `skill.json.slug "${skillJson.slug}" must match top-level slug "${input.slug}"`,
        400,
        'package',
      );
    }
    if (skillJson.name !== input.name) {
      throw new SkillDraftError(
        `skill.json.name "${skillJson.name}" must match top-level name "${input.name}"`,
        400,
        'package',
      );
    }

    // Gate 2 — frontmatter
    const fm = gateFrontmatter(skillMdContent);
    warnings.push(...fm.warnings);
    // Frontmatter <-> skill.json name consistency
    if (fm.fmName && fm.fmName !== skillJson.slug && fm.fmName !== skillJson.name.toLowerCase().replace(/\s+/g, '-')) {
      // soft check — frontmatter name should align with slug
      if (fm.fmName !== input.slug) {
        throw new SkillDraftError(
          `frontmatter.name "${fm.fmName}" must equal slug "${input.slug}"`,
          400,
          'frontmatter',
        );
      }
    }

    // Gate 4 — requires (warn)
    warnings.push(...gateRequires(skillJson));

    // Gate 5 — security
    gateSecurity(skillJson);

    // Gate 6 — sample (warn)
    warnings.push(...gateSample(skillJson));

    // Step 6: derive IMSkill columns from skill.json (§2.6 mapping)
    const license = skillJson.license || fm.fmLicense || 'MIT';
    const compatibility = JSON.stringify(skillJson.compatibility || []);
    const requires = JSON.stringify(skillJson.runtime?.requires || {});
    const executableJson = skillJson.runtime?.executableJson || null;
    const version = skillJson.version || '1.0.0';

    // Step 7: assemble metadata.skillJson + metadata.authoring
    const authoring = input.metadata?.authoring ?? {};
    // release201/08 §2.0 — newly created drafts settle at sub-stage
    // `scaffold` (intake → source_review → design → scaffold all happen
    // synchronously inside createDraft before the IMSkill row exists). The
    // `implement` sub-stage is owned by patchDraft; subsequent main-state
    // promotes (eval / review / published) settle to the entry sub-stage of
    // their target main state.
    const metadataObj: Record<string, unknown> = {
      authoring: {
        ...authoring,
        draftRevisionHistory: [
          ...(Array.isArray((authoring as any).draftRevisionHistory) ? (authoring as any).draftRevisionHistory : []),
          {
            revision: manifest.revision,
            createdAt: new Date().toISOString(),
            regenerated: false,
          },
        ],
      },
      skillJson: {
        inputs: skillJson.inputs,
        outputs: skillJson.outputs,
        sampleTasks: skillJson.sampleTasks,
        security: skillJson.security,
        provenance: skillJson.provenance,
        ...(skillJson.metadata ? { metadata: skillJson.metadata } : {}),
      },
      validationWarnings: warnings,
      lifecycleSubStage: 'scaffold',
    };

    // Step 8: INSERT IMSkill row
    // release201/08 §5.1 — newly created drafts always start at
    // lifecycleStage='draft' + publishScope='private'. Cast to any so the
    // generated Prisma client (which may be regenerated lazily by the dev
    // stack) doesn't block compilation before `prisma generate` runs.
    const created = await prisma.iMSkill.create({
      data: {
        slug: input.slug,
        name: input.name,
        description: input.description,
        category: skillJson.category || 'general',
        tags: '[]',
        author: '',
        source: 'community',
        sourceUrl: '',
        sourceId: `draft:${input.slug}`,
        content: skillMdContent,
        contentManifest: JSON.stringify(manifest.files),
        contentManifestRevision: manifest.revision,
        status: 'draft',
        license,
        compatibility,
        requires,
        version,
        executableJson: executableJson as any,
        ownerAgentId: input.ownerAgentId,
        workspaceId: input.workspaceId,
        metadata: JSON.stringify(metadataObj),
        signals: '[]',
        lifecycleStage: 'draft',
        publishScope: 'private',
      } as any,
    });

    // release201/08 §3.0 / S21 — tag the authoring agent's spawn
    // conversation as `dev` so Studio session-links can thread it from the
    // business session that triggered createDraft. Caller threads
    // `metadata.authoring.conversationId` (the authoring agent's session)
    // and optionally `parentConversationId` (the business session). 4
    // session-role plumbing (business / dev / test / review).
    const authoringMeta = (input.metadata?.authoring as Record<string, unknown> | undefined) ?? {};
    const devConversationId = typeof authoringMeta.conversationId === 'string' ? authoringMeta.conversationId : null;
    const parentConversationId =
      typeof authoringMeta.parentConversationId === 'string' ? authoringMeta.parentConversationId : null;
    if (devConversationId && this.deps.conversations) {
      try {
        await this.deps.conversations.setSkillDevRole(devConversationId, created.id, 'dev', {
          parentConversationId: parentConversationId ?? undefined,
          projectId: typeof authoringMeta.projectId === 'string' ? (authoringMeta.projectId as string) : undefined,
        });
      } catch (cErr) {
        console.warn(`${LOG} tag dev conversation failed: ${(cErr as Error).message}`);
      }
    }

    // release201/08 §10.6 / S21 — emit the authoring SSE event family. The
    // draft row exists now so SyncService can scope the events to the
    // workspace owner. We walk the sub-stages in order so consumers can
    // animate the pipeline rail through intake → source_review → design →
    // scaffold; each setLifecycleSubStage also fires state_changed.
    if (this.deps.lifecycle) {
      try {
        const sourceKind =
          skillJson.provenance && typeof skillJson.provenance.sourceKind === 'string'
            ? skillJson.provenance.sourceKind
            : 'inline-spec';
        const sourceRefs: string[] = Array.isArray(skillJson.provenance?.sourceRefs)
          ? skillJson.provenance!.sourceRefs!
          : [];
        // 0. started — entry into intake
        await this.deps.lifecycle.notifyAuthoringStarted({
          skill: created,
          sourceKind,
          projectId: (input.metadata?.authoring as any)?.projectId ?? null,
        });
        // 1. intake → source_review (also emits state_changed)
        await this.deps.lifecycle.setLifecycleSubStage(created, 'source_review', 'createDraft fetch');
        await this.deps.lifecycle.notifySourceReviewed({
          skill: created,
          sourceRefs,
          referenceAssetIds: [],
        });
        // 2. source_review → design
        await this.deps.lifecycle.setLifecycleSubStage(created, 'design', 'createDraft compose');
        // 3. validation_started — declare all 7 gates so the UI's
        //    validation panel can render the rail. Gates 1-6 were already
        //    executed synchronously above (results below); gate-7 (runtime
        //    sandbox smoke) is fired-and-forget by runGate7Smoke after
        //    createDraft returns. The 7-gate validation_completed is emitted
        //    by runGate7Smoke once the smoke either queues or short-circuits.
        await this.deps.lifecycle.notifyValidationStarted({
          skill: created,
          gates: ['manifest', 'frontmatter', 'package', 'requires', 'security', 'sample', 'runtime'],
        });
        // Interim 6-gate validation_completed — the runtime gate result
        // arrives on the second emit from runGate7Smoke (release201/07 §2.7
        // footnote: gate-7 is fire-and-forget background smoke).
        await this.deps.lifecycle.notifyValidationCompleted({
          skill: created,
          gates: [
            { name: 'manifest', status: 'pass' },
            { name: 'frontmatter', status: 'pass' },
            { name: 'package', status: 'pass' },
            { name: 'requires', status: warnings.some((w) => w.gate === 'requires') ? 'warn' : 'pass' },
            { name: 'security', status: 'pass' },
            { name: 'sample', status: warnings.some((w) => w.gate === 'sample') ? 'warn' : 'pass' },
          ],
          failedGates: [],
        });
        // 4. design → scaffold (manifest persisted)
        await this.deps.lifecycle.setLifecycleSubStage(created, 'scaffold', 'createDraft scaffold');
        await this.deps.lifecycle.notifyBundleScaffolded({
          skill: created,
          manifestRevision: manifest.revision,
          fileCount: manifest.files.length,
        });
      } catch (sseErr) {
        // SSE is best-effort — never block draft creation.
        console.warn(`${LOG} authoring SSE fan-out failed: ${(sseErr as Error).message}`);
      }
    }

    // Step 9: create skill-review IMTask assigned to workspace owner.
    //
    // The task is persisted via prisma.iMTask.create (no TaskService singleton
    // exists outside the IM server boot), but the §10 acceptance template
    // auto-apply step is invoked manually right after, matching what
    // TaskService.createTask() does for the in-process API path. This keeps
    // skill-review tasks from shipping without the default 3-criterion
    // template (§5.3 + §10 release201/07 P0-2 gate).
    let reviewTaskId: string | null = null;
    try {
      const workspace = await prisma.iMWorkspace.findUnique({
        where: { id: input.workspaceId },
        select: { ownerImUserId: true },
      });
      if (workspace?.ownerImUserId) {
        const task = await prisma.iMTask.create({
          data: {
            title: `Skill draft '${input.slug}' ready for review`,
            description: `Authoring agent ${input.ownerAgentId} submitted draft ${created.id}. Open in Studio Authoring to review and decide whether to promote to lifecycle eval.`,
            capability: 'skill-review',
            creatorId: input.ownerAgentId,
            assigneeId: workspace.ownerImUserId,
            workspaceId: input.workspaceId,
            status: 'pending',
            metadata: JSON.stringify({
              skillDraftId: created.id,
              skillSlug: input.slug,
              source: 'release201/07 skill-authoring',
            }),
          },
        });
        reviewTaskId = task.id;

        // release201/10 §5.3 — auto-apply default acceptance template by
        // capability. Best-effort: a missing template is non-fatal (the task
        // still ships, the reviewer just hand-fills criteria).
        try {
          const applied = await getTaskAcceptanceService().applyDefaultTemplateOnCreate(
            task.id,
            'skill-review',
            input.workspaceId,
            input.ownerAgentId,
          );
          if (applied.applied) {
            console.log(`${LOG} applied skill-review template ${applied.templateId} to task ${task.id}`);
          }
        } catch (tplErr) {
          console.warn(
            `${LOG} failed to apply skill-review acceptance template to ${task.id}:`,
            (tplErr as Error).message,
          );
        }

        // release201/11 §4 #15 — emit skill.draft.review_assigned metric. Only
        // emit when the task was actually created (assignee resolved).
        try {
          metricEmit({
            namespace: 'skill.draft',
            name: 'review_assigned',
            value: 1,
            dims: {
              workspaceId: input.workspaceId,
              skillId: created.id,
              reviewerUserId: workspace.ownerImUserId,
            },
          });
        } catch (mErr) {
          console.warn(`${LOG} metric skill.draft.review_assigned failed:`, (mErr as Error).message);
        }
      }
    } catch (err) {
      console.warn(`${LOG} failed to create skill-review task:`, (err as Error).message);
    }

    // release201/11 §4 #13 — emit skill.draft.created metric. Source kind is
    // taken from skill.json provenance.sourceKind (07 §2.6) when present.
    try {
      const sourceKind =
        skillJson.provenance && typeof skillJson.provenance.sourceKind === 'string'
          ? skillJson.provenance.sourceKind
          : 'inline-spec';
      metricEmit({
        namespace: 'skill.draft',
        name: 'created',
        value: 1,
        dims: {
          workspaceId: input.workspaceId,
          skillId: created.id,
          sourceKind,
        },
      });
    } catch (mErr) {
      console.warn(`${LOG} metric skill.draft.created failed:`, (mErr as Error).message);
    }

    console.log(
      `${LOG} created draft id=${created.id} slug=${input.slug} ownerAgent=${input.ownerAgentId.slice(-8)} workspace=${input.workspaceId.slice(-8)} warnings=${warnings.length}`,
    );

    // Step 10: release201/07 §2.7 gate-7 — schedule fire-and-forget sandbox
    // smoke. Never blocks the response: setImmediate detaches the work onto
    // the next tick so 200 OK ships before the smoke even starts. Errors are
    // logged but never propagated (warn-level gate by design).
    setImmediate(() => {
      this.runGate7Smoke(created.id, skillJson, input.ownerAgentId).catch((sErr) => {
        console.warn(`${LOG} gate-7 runtime smoke (background) failed for ${created.id}: ${(sErr as Error).message}`);
      });
    });

    return {
      id: created.id,
      slug: input.slug,
      manifestRevision: manifest.revision,
      reviewTaskId,
      validationWarnings: warnings,
    };
  }

  /**
   * release201/07 §2.7 gate-7 — runtime sandbox smoke. Fire-and-forget; runs
   * AFTER createDraft has returned (scheduled via setImmediate).
   *
   * Picks `skill.json.sampleTasks[0]` (when present) as the lone test case,
   * enqueues a smoke-tagged IMSkillEvalRun (status='queued'), and emits
   *  • `skill.authoring.smoke_started` (lifecycle service)
   *  • `skill.authoring.validation_completed` with the 7-gate vector
   *    INCLUDING gate-7 (so the UI's validation panel can close the loop)
   *
   * Outcome is always warn-level — gate-7 NEVER blocks createDraft. The
   * smoke row stays in `queued` until the daemon-side EvalSessionRunner
   * (release201/08 §3.2) picks it up; in cloud-only dev/test envs (no
   * daemon attached) the warning persists as `gate7=queued_no_runner` in
   * metadata.validationWarnings.
   *
   * NOTE: this does NOT promote draft→eval (startEvalRun would; we
   * deliberately avoid that to keep gate-7 separate from the SOP's manual
   * promote action — release201/07 §2.7 "Blocking" column = warn).
   */
  private async runGate7Smoke(skillId: string, skillJson: SkillJsonInput, actorImUserId: string): Promise<void> {
    const samples = Array.isArray(skillJson.sampleTasks) ? skillJson.sampleTasks : [];
    const sample = samples[0];

    // Refetch the persisted skill row for SSE recipient resolution.
    const skill = await prisma.iMSkill.findUnique({ where: { id: skillId } }).catch(() => null);
    if (!skill) {
      console.warn(`${LOG} gate-7 smoke: skill ${skillId} disappeared before smoke could start`);
      return;
    }

    // ── Branch 1: no sample task → record as a queued_no_sample warning.
    //   The companion gate-6 already warned about this; gate-7 echoes the
    //   same problem from a runtime perspective so the validation panel
    //   surfaces both.
    if (!sample) {
      await this.appendGate7Warning(skillId, {
        gate: 'runtime',
        message:
          'gate-7 sandbox smoke skipped: no sampleTasks in skill.json (release201/07 §2.7 requires at least 1 sample task for runtime smoke)',
      });
      if (this.deps.lifecycle) {
        try {
          await this.deps.lifecycle.notifyValidationCompleted({
            skill,
            gates: [
              { name: 'manifest', status: 'pass' },
              { name: 'frontmatter', status: 'pass' },
              { name: 'package', status: 'pass' },
              { name: 'requires', status: 'pass' },
              { name: 'security', status: 'pass' },
              { name: 'sample', status: 'warn' },
              { name: 'runtime', status: 'warn' },
            ],
            failedGates: [],
          });
        } catch (sseErr) {
          console.warn(`${LOG} gate-7 smoke (no sample) SSE emit failed: ${(sseErr as Error).message}`);
        }
      }
      return;
    }

    // ── Branch 2: sample present → enqueue the IMSkillEvalRun row.
    //   Tagged in testCasesJson.smoke=true so the daemon-side runner can
    //   short-circuit a full eval and only run gate-7 worth of work.
    const runId = `gate7_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    // release201/24 §2.1 — NO `expectedOutputPattern: undefined`. The daemon
    // scorer (scoreCase) uses `acceptanceCriteria` as the assertion; if the
    // sample has none, the verdict is `inconclusive` (counted as fail) rather
    // than an auto-pass. Built once so the persisted row + the daemon dispatch
    // carry the identical case set.
    const smokeTestCases = [
      {
        id: 'gate7-smoke-0',
        input: sample.prompt,
        timeout_ms: GATE7_SMOKE_TIMEOUT_MS,
        acceptanceCriteria: Array.isArray(sample.acceptanceCriteria) ? sample.acceptanceCriteria : [],
        title: sample.title,
      },
    ];
    try {
      await (prisma as any).iMSkillEvalRun.create({
        data: {
          id: runId,
          skillId,
          status: 'queued',
          passCount: 0,
          failCount: 0,
          testCasesJson: JSON.stringify({
            smoke: true,
            origin: 'release201/07 gate-7',
            timeoutMs: GATE7_SMOKE_TIMEOUT_MS,
            allowlistBuiltins: GATE7_SMOKE_ALLOWLIST_BUILTINS,
            testCases: smokeTestCases,
          }),
        },
      });
    } catch (eErr) {
      // Persisting the eval row is best-effort; if it fails the smoke
      // collapses to a warning. We still emit validation_completed so the
      // UI's gate panel closes.
      console.warn(`${LOG} gate-7 smoke enqueue failed: ${(eErr as Error).message}`);
      await this.appendGate7Warning(skillId, {
        gate: 'runtime',
        message: `gate-7 sandbox smoke queue failed: ${(eErr as Error).message}`,
      });
      return;
    }

    // Emit `skill.authoring.validation_completed` with the full 7-gate
    // vector. gate-7 settles to 'warn' because the smoke is queued — the
    // daemon-side EvalSessionRunner will flip it to pass/fail when it
    // resolves the IMSkillEvalRun row (and at that point the lifecycle
    // service's recordEvalFinish() emits its own validation_completed for
    // the runtime gate's terminal state, release201/08 §10.6).
    if (this.deps.lifecycle) {
      try {
        await this.deps.lifecycle.notifyValidationCompleted({
          skill,
          gates: [
            { name: 'manifest', status: 'pass' },
            { name: 'frontmatter', status: 'pass' },
            { name: 'package', status: 'pass' },
            { name: 'requires', status: 'pass' },
            { name: 'security', status: 'pass' },
            { name: 'sample', status: 'pass' },
            { name: 'runtime', status: 'warn' },
          ],
          failedGates: [],
        });
      } catch (sseErr) {
        console.warn(`${LOG} gate-7 smoke validation_completed emit failed: ${(sseErr as Error).message}`);
      }
    }

    // release201/24 §3 honesty — actually dispatch the smoke to the owner
    // agent's bound daemon (mirrors startEvalRun). Without this the row sat
    // `queued` with `resultsJson=null` forever (the forbidden "permanent
    // queued" pattern, cookbook §5). The dispatcher resolves it to `running`
    // (a daemon picked it up) or stamps `queued_no_runner` honestly — either
    // way the row never stays silently queued.
    let outcome: { accepted: boolean; daemonId?: string; reason?: string };
    if (this.deps.lifecycle) {
      outcome = await this.deps.lifecycle
        .dispatchSmokeRun({
          runId,
          skill,
          testCases: smokeTestCases,
          allowlistBuiltins: GATE7_SMOKE_ALLOWLIST_BUILTINS,
        })
        .catch((dErr) => ({ accepted: false, reason: (dErr as Error).message }));
    } else {
      outcome = { accepted: false, reason: 'no lifecycle service wired' };
    }

    // Record the smoke status as a warning so reviewers see the gate-7 row
    // in metadata.validationWarnings without inspecting IMSkillEvalRun.
    await this.appendGate7Warning(skillId, {
      gate: 'runtime',
      message: outcome.accepted
        ? `gate-7 sandbox smoke dispatched to daemon ${outcome.daemonId ?? '?'} (runId=${runId}); EvalSessionRunner will POST results. timeoutMs=${GATE7_SMOKE_TIMEOUT_MS}`
        : `gate-7 sandbox smoke queued_no_runner (runId=${runId}): ${outcome.reason ?? 'no daemon'}. allowlistBuiltins=${GATE7_SMOKE_ALLOWLIST_BUILTINS.join(',')} timeoutMs=${GATE7_SMOKE_TIMEOUT_MS}`,
    });

    console.log(
      `${LOG} gate-7 smoke ${outcome.accepted ? 'dispatched' : 'queued_no_runner'} skill=${skillId.slice(-8)} run=${runId} sample="${sample.title.slice(0, 32)}" actor=${actorImUserId.slice(-8)}`,
    );
  }

  /**
   * Append a gate-7 entry to metadata.validationWarnings[] without touching
   * other metadata fields. Best-effort: any DB error is logged and swallowed
   * so the background smoke never crashes the draft pipeline.
   */
  private async appendGate7Warning(skillId: string, warning: ValidationWarning): Promise<void> {
    try {
      const row = await prisma.iMSkill.findUnique({
        where: { id: skillId },
        select: { metadata: true },
      });
      if (!row) return;
      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(row.metadata || '{}');
      } catch {
        meta = {};
      }
      const existing = Array.isArray(meta.validationWarnings) ? (meta.validationWarnings as ValidationWarning[]) : [];
      meta.validationWarnings = [...existing, warning];
      await prisma.iMSkill.update({
        where: { id: skillId },
        data: { metadata: JSON.stringify(meta) },
      });
    } catch (err) {
      console.warn(`${LOG} appendGate7Warning failed for ${skillId}: ${(err as Error).message}`);
    }
  }

  /**
   * Patch a draft — add / update / delete files. Recomputes merkle, appends
   * to metadata.authoring.draftRevisionHistory. Only allowed on status='draft'.
   */
  async patchDraft(
    id: string,
    actorImUserId: string,
    input: PatchDraftInput,
  ): Promise<{ id: string; manifestRevision: string }> {
    const existing = await prisma.iMSkill.findUnique({ where: { id } });
    if (!existing) {
      throw new SkillDraftError(`draft ${id} not found`, 404);
    }
    if (existing.status !== 'draft') {
      throw new SkillDraftError(
        `cannot patch skill with status=${existing.status}; only draft skills are patchable`,
        409,
      );
    }
    // ownership check
    if (existing.ownerAgentId !== actorImUserId) {
      // also allow workspace owner
      if (existing.workspaceId) {
        const ws = await prisma.iMWorkspace.findFirst({
          where: { id: existing.workspaceId, deletedAt: null, ownerImUserId: actorImUserId },
          select: { id: true },
        });
        if (!ws) {
          throw new SkillDraftError('not authorised to patch this draft', 403);
        }
      } else {
        throw new SkillDraftError('not authorised to patch this draft', 403);
      }
    }

    // Apply ops to current manifest
    const currentManifest: ManifestFile[] = existing.contentManifest ? JSON.parse(existing.contentManifest) : [];
    const fileMap = new Map<string, Buffer>();
    for (const f of currentManifest) {
      if (f.inline && f.content) {
        fileMap.set(f.path, Buffer.from(f.content, 'base64'));
      } else {
        // For draft phase we never use S3 URLs; treat as empty
        fileMap.set(f.path, Buffer.from(''));
      }
    }

    for (const op of input.files) {
      if (op.op === 'delete') {
        fileMap.delete(op.path);
      } else {
        const bytes = op.contentBase64
          ? Buffer.from(op.contentBase64, 'base64')
          : Buffer.from(op.content ?? '', 'utf8');
        fileMap.set(op.path, bytes);
      }
    }

    // Rebuild manifest
    const newInputs: ManifestFileInput[] = Array.from(fileMap.entries()).map(([path, bytes]) => ({ path, bytes }));
    const newManifest = await buildManifest(newInputs);

    const size = totalSize(newManifest.files);
    if (size > DRAFT_TOTAL_SIZE_LIMIT_BYTES) {
      throw new SkillDraftError(
        `patched manifest total size ${size} bytes exceeds limit ${DRAFT_TOTAL_SIZE_LIMIT_BYTES}`,
        413,
      );
    }

    // Reorder so SKILL.md and skill.json are first / second (package gate compatibility)
    const orderedFiles: ManifestFile[] = [];
    const skillMd = newManifest.files.find((f) => f.path === 'SKILL.md');
    const skillJson = newManifest.files.find((f) => f.path === 'skill.json');
    if (skillMd) orderedFiles.push(skillMd);
    if (skillJson) orderedFiles.push(skillJson);
    for (const f of newManifest.files) {
      if (f.path !== 'SKILL.md' && f.path !== 'skill.json') orderedFiles.push(f);
    }
    const orderedRevision = computeManifestRevision(orderedFiles.map((f) => ({ path: f.path, sha256: f.sha256 })));

    // Update metadata revision history
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(existing.metadata || '{}');
    } catch {
      meta = {};
    }
    const authoring = (meta.authoring as Record<string, unknown> | undefined) || {};
    const history = Array.isArray(authoring.draftRevisionHistory) ? authoring.draftRevisionHistory : [];
    history.push({
      revision: orderedRevision,
      createdAt: new Date().toISOString(),
      regenerated: false,
      reason: input.reason ?? null,
    });
    meta.authoring = { ...authoring, draftRevisionHistory: history };

    // Refresh content column from SKILL.md if present
    let contentUpdate: string | undefined;
    if (skillMd?.content) {
      contentUpdate = Buffer.from(skillMd.content, 'base64').toString('utf8');
    }

    // release201/08 §2.0 — patchDraft is the canonical entry into the
    // `implement` sub-stage. Record it on the metadata blob so Studio
    // pipeline rail tracks the user-edit phase between intake/scaffold and
    // static_validate. Persisted atomically with the manifest update.
    (meta as any).lifecycleSubStage = 'implement';

    await prisma.iMSkill.update({
      where: { id },
      data: {
        contentManifest: JSON.stringify(orderedFiles),
        contentManifestRevision: orderedRevision,
        metadata: JSON.stringify(meta),
        ...(contentUpdate !== undefined ? { content: contentUpdate } : {}),
      },
    });

    // Emit state_changed so subscribers see the implement transition. Pass
    // the freshly-updated row to setLifecycleSubStage so it skips the DB
    // write (no-op when sub-stage already matches) and just emits.
    if (this.deps.lifecycle) {
      try {
        const refreshed = await prisma.iMSkill.findUnique({ where: { id } });
        if (refreshed) {
          await this.deps.lifecycle.setLifecycleSubStage(refreshed, 'implement', input.reason ?? 'patchDraft');
        }
      } catch (sseErr) {
        console.warn(`${LOG} patchDraft state_changed emit failed: ${(sseErr as Error).message}`);
      }
    }

    console.log(`${LOG} patched draft id=${id} new revision=${orderedRevision.slice(0, 8)}`);

    return { id, manifestRevision: orderedRevision };
  }

  /**
   * Regenerate a draft — release201/24 §Phase2. Unlike the old version (which
   * only logged), this now REALLY triggers a rewrite:
   *   1. appends a regenerate marker to revision history (with failedCases),
   *   2. resets lifecycleSubStage → `implement` + emits `state_changed` so the
   *      Studio pipeline reflects the in-flight rewrite,
   *   3. dispatches a `skill-authoring` IMTask to the owner authoring agent
   *      carrying the reason + failed cases, so the agent rewrites the manifest
   *      via `cloud skill draft patch` and a fresh eval can re-run.
   * Returns a sessionId the authoring agent uses as correlation.
   */
  async regenerateDraft(
    id: string,
    actorImUserId: string,
    input: RegenerateDraftInput,
  ): Promise<{ id: string; sessionId: string; manifestRevision: string; rewriteTaskId?: string }> {
    const existing = await prisma.iMSkill.findUnique({ where: { id } });
    if (!existing) {
      throw new SkillDraftError(`draft ${id} not found`, 404);
    }
    if (existing.status !== 'draft') {
      throw new SkillDraftError(`only draft skills can be regenerated (status=${existing.status})`, 409);
    }
    if (existing.ownerAgentId !== actorImUserId) {
      if (existing.workspaceId) {
        const ws = await prisma.iMWorkspace.findFirst({
          where: { id: existing.workspaceId, deletedAt: null, ownerImUserId: actorImUserId },
          select: { id: true },
        });
        if (!ws) {
          throw new SkillDraftError('not authorised to regenerate this draft', 403);
        }
      } else {
        throw new SkillDraftError('not authorised to regenerate this draft', 403);
      }
    }

    const sessionId = `regen-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(existing.metadata || '{}');
    } catch {
      meta = {};
    }
    const authoring = (meta.authoring as Record<string, unknown> | undefined) || {};
    const history = Array.isArray(authoring.draftRevisionHistory) ? authoring.draftRevisionHistory : [];
    history.push({
      revision: existing.contentManifestRevision,
      createdAt: new Date().toISOString(),
      regenerated: true,
      reason: input.reason,
      sessionId,
      newSources: input.newSources ?? [],
    });
    meta.authoring = { ...authoring, draftRevisionHistory: history };

    // release201/24 §Phase2 — reset sub-stage to `implement` so Studio shows
    // the rewrite as in-flight (not stuck in a prior validated state).
    (meta as any).lifecycleSubStage = 'implement';

    await prisma.iMSkill.update({
      where: { id },
      data: { metadata: JSON.stringify(meta) },
    });

    // release201/24 §Phase2 — REALLY trigger the rewrite by dispatching a
    // skill-authoring task back to the owner agent. The agent reads the
    // reason + failed cases and patches the manifest via `cloud skill draft
    // patch`, after which a fresh eval run can verify the improvement.
    // Best-effort: a task-creation failure does not fail the regenerate call.
    let rewriteTaskId: string | undefined;
    if (existing.ownerAgentId) {
      try {
        const failedSummary =
          Array.isArray(input.failedCases) && input.failedCases.length > 0
            ? `\n\nFailed eval cases to address:\n${input.failedCases
                .map((f) => `- ${f.id}: ${f.error ?? 'failed'}`)
                .join('\n')}`
            : '';
        const task = await prisma.iMTask.create({
          data: {
            title: `Rewrite skill draft '${existing.slug}'`,
            description: `Regenerate the draft manifest. Reason: ${input.reason}${failedSummary}\n\nUse \`cloud skill draft patch ${id}\` to replace the failing files, then the lifecycle will re-run eval. session=${sessionId}`,
            capability: 'skill-authoring',
            creatorId: existing.ownerAgentId,
            assigneeId: existing.ownerAgentId,
            workspaceId: existing.workspaceId ?? '',
            status: 'pending',
            metadata: JSON.stringify({
              skillDraftId: id,
              skillSlug: existing.slug,
              regenerate: true,
              sessionId,
              reason: input.reason,
              failedCases: input.failedCases ?? [],
              source: 'release201/24 regenerate',
            }),
          },
        });
        rewriteTaskId = task.id;
      } catch (taskErr) {
        console.warn(`${LOG} regenerate rewrite-task dispatch failed for ${id}: ${(taskErr as Error).message}`);
      }
    }

    // Surface the rewrite-in-progress sub-stage transition.
    if (this.deps.lifecycle) {
      try {
        const refreshed = await prisma.iMSkill.findUnique({ where: { id } });
        if (refreshed) {
          await this.deps.lifecycle.setLifecycleSubStage(refreshed, 'implement', `regenerate: ${input.reason}`);
        }
      } catch (sseErr) {
        console.warn(`${LOG} regenerate state_changed emit failed: ${(sseErr as Error).message}`);
      }
    }

    // release201/11 §4 #14 — emit skill.draft.regenerated metric.
    try {
      metricEmit({
        namespace: 'skill.draft',
        name: 'regenerated',
        value: 1,
        dims: {
          workspaceId: existing.workspaceId ?? '',
          skillId: id,
          reason: input.reason,
        },
      });
    } catch (mErr) {
      console.warn(`${LOG} metric skill.draft.regenerated failed:`, (mErr as Error).message);
    }

    console.log(
      `${LOG} regenerate requested id=${id} session=${sessionId} reason="${input.reason}" rewriteTask=${rewriteTaskId ?? 'none'}`,
    );

    return { id, sessionId, manifestRevision: existing.contentManifestRevision ?? '', rewriteTaskId };
  }

  /** Show a draft by id (any caller; returns full manifest + history). */
  async getDraft(id: string): Promise<any | null> {
    const skill = await prisma.iMSkill.findUnique({ where: { id } });
    if (!skill || skill.status !== 'draft') return null;
    let metadata: any = {};
    try {
      metadata = JSON.parse(skill.metadata || '{}');
    } catch {
      metadata = {};
    }
    let files: any[] = [];
    if (skill.contentManifest) {
      try {
        const parsed = JSON.parse(skill.contentManifest);
        files = Array.isArray(parsed) ? parsed : Array.isArray(parsed.files) ? parsed.files : [];
      } catch {
        files = [];
      }
    }
    return {
      id: skill.id,
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
      status: skill.status,
      workspaceId: skill.workspaceId,
      ownerAgentId: skill.ownerAgentId,
      manifestRevision: skill.contentManifestRevision,
      files,
      license: skill.license,
      compatibility: (() => {
        try {
          return JSON.parse(skill.compatibility || '[]');
        } catch {
          return [];
        }
      })(),
      requires: (() => {
        try {
          return JSON.parse(skill.requires || '{}');
        } catch {
          return {};
        }
      })(),
      executableJson: skill.executableJson,
      metadata,
      createdAt: skill.createdAt,
      updatedAt: skill.updatedAt,
    };
  }

  /** List drafts for a workspace (any member can read). */
  async listDrafts(workspaceId: string): Promise<any[]> {
    const skills = await prisma.iMSkill.findMany({
      where: { workspaceId, status: 'draft' },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        slug: true,
        name: true,
        description: true,
        ownerAgentId: true,
        contentManifestRevision: true,
        updatedAt: true,
        createdAt: true,
      },
    });
    return skills;
  }
}
