/**
 * Skill lifecycle integration test fixtures.
 *
 * Helpers to build valid skill manifest payloads (SKILL.md + skill.json) for
 * the createDraft endpoint. Mirrors the 7-gate contract in
 * src/im/services/skill-draft.service.ts:
 *   - SKILL.md must be files[0] with valid frontmatter (name + description ≥50)
 *   - skill.json must be files[1] with schemaVersion=1, slug, name, version,
 *     license, compatibility[], runtime, inputs/outputs, sampleTasks[],
 *     security.dataAccess[], provenance.sourceKind
 *
 * Files are base64-encoded in the input (gatePackage expects files[].content
 * to be base64) — keep this util close to the canonical encoding.
 */

export interface FixtureOpts {
  slug: string;
  /** Override skill.json.name (defaults to slug). */
  name?: string;
  /** Override skill.json.description (defaults to lorem ≥50 chars). */
  description?: string;
  /** provenance.sourceKind — picks which gate-7 path is taken. */
  sourceKind?: 'inline-spec' | 'doc-url' | 'code-source' | 'service-endpoint';
  /** sourceRefs threaded into provenance.sourceRefs and metadata.authoring. */
  sourceRefs?: string[];
  /** Override SKILL.md body. Defaults to a short workflow stub. */
  skillMdBody?: string;
  /** Skip sampleTasks (gate 6 → warn). */
  noSampleTasks?: boolean;
  /** dataAccess override (default ['workspace-assets']). */
  dataAccess?: Array<'workspace-assets' | 'memory' | 'external-network' | 'secrets' | 'filesystem'>;
}

const DEFAULT_DESCRIPTION =
  'Integration test skill description; must clear the 50-char minimum to pass gate-2 frontmatter check.';

/**
 * Build files[] payload for POST /skills/draft. Returns the array suitable for
 * the request body (path + base64 content) plus the parsed skill.json so the
 * test can assert on the same data.
 */
export function buildSkillFiles(opts: FixtureOpts): {
  files: Array<{ path: string; content: string }>;
  skillJson: Record<string, unknown>;
  skillMd: string;
} {
  const name = opts.name ?? opts.slug;
  const description = opts.description ?? DEFAULT_DESCRIPTION;
  const dataAccess = opts.dataAccess ?? ['workspace-assets'];
  const sourceKind = opts.sourceKind ?? 'inline-spec';
  const sourceRefs = opts.sourceRefs ?? [];

  const skillMdBody =
    opts.skillMdBody ??
    [
      '',
      `# ${name}`,
      '',
      '## Workflow',
      '',
      '1. Inspect inputs.',
      '2. Run the inline step.',
      '3. Emit acceptance evidence.',
      '',
    ].join('\n');

  const skillMd = ['---', `name: ${opts.slug}`, `description: ${description}`, 'license: MIT', '---', skillMdBody].join(
    '\n',
  );

  const skillJson: Record<string, unknown> = {
    schemaVersion: 1,
    slug: opts.slug,
    name,
    description,
    category: 'general',
    version: '1.0.0',
    license: 'MIT',
    compatibility: ['prismer-sdk'],
    runtime: {
      kind: 'text-workflow',
      requires: {
        capabilities: ['tasks'],
      },
    },
    inputs: [{ name: 'prompt', type: 'string', required: true }],
    outputs: [{ name: 'result', type: 'string', required: true }],
    sampleTasks: opts.noSampleTasks
      ? []
      : [
          {
            title: 'Smoke',
            prompt: 'Say hello',
            acceptanceCriteria: ['response_non_empty'],
          },
        ],
    security: {
      dataAccess,
      humanApprovalRequiredFor: [],
    },
    provenance: {
      sourceKind,
      sourceRefs,
      authoredBy: 'it-fixture',
      authoredAt: new Date().toISOString(),
    },
  };

  // Need humanApprovalRequiredFor non-empty when sensitive scopes used (gate 5).
  const sensitiveScopes = dataAccess.filter((s) => s === 'external-network' || s === 'secrets' || s === 'filesystem');
  if (sensitiveScopes.length > 0) {
    (skillJson.security as Record<string, unknown>).humanApprovalRequiredFor = ['network_egress'];
  }

  // POST /skills/draft accepts either `content` (utf-8) or `contentBase64`
  // (base64-encoded bytes); see skill-draft.service.ts:decodeFile. We pass
  // raw utf-8 in `content` so the service's buildManifest re-encodes to the
  // manifest's base64 form via Buffer.from(content,'utf8').
  const files = [
    { path: 'SKILL.md', content: skillMd },
    { path: 'skill.json', content: JSON.stringify(skillJson, null, 2) },
  ];

  return { files, skillJson, skillMd };
}

/**
 * Build the full POST /skills/draft body. Caller supplies workspaceId +
 * ownerAgentId (typically the owner's imUserId).
 */
export function buildDraftBody(opts: {
  slug: string;
  name?: string;
  description?: string;
  workspaceId: string;
  ownerAgentId: string;
  sourceKind?: FixtureOpts['sourceKind'];
  sourceRefs?: string[];
  noSampleTasks?: boolean;
  dataAccess?: FixtureOpts['dataAccess'];
}): Record<string, unknown> {
  const { files } = buildSkillFiles({
    slug: opts.slug,
    name: opts.name,
    description: opts.description,
    sourceKind: opts.sourceKind,
    sourceRefs: opts.sourceRefs,
    noSampleTasks: opts.noSampleTasks,
    dataAccess: opts.dataAccess,
  });
  return {
    slug: opts.slug,
    name: opts.name ?? opts.slug,
    description: opts.description ?? DEFAULT_DESCRIPTION,
    workspaceId: opts.workspaceId,
    ownerAgentId: opts.ownerAgentId,
    files,
    metadata: {
      authoring: {
        sourceKind: opts.sourceKind ?? 'inline-spec',
        sourceRefs: opts.sourceRefs ?? [],
      },
    },
  };
}

/** Short unique slug per-test to avoid cross-test collisions. */
let counter = 0;
export function uniqueSlug(prefix = 'it-skill'): string {
  counter += 1;
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 6);
  // Slug regex: /^[a-z][a-z0-9-]*$/.
  return `${prefix}-${t}-${counter}-${r}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}
