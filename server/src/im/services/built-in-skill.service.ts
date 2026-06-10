import fs from 'fs/promises';
import path from 'path';
import prisma from '../db';
import { AgentSkillService } from './agent-skill.service';
import {
  parseFrontmatter,
  validateAgainstDirName,
  type FrontmatterFields,
} from '../skills/frontmatter';
import {
  buildManifest,
  computeManifestRevision,
  sha256Hex,
  getInlineThresholdBytes,
  type ManifestFile,
  type ManifestFileInput,
  type ManifestResult,
} from '../skills/manifest';
import { config } from '../config';
import { isS3Available, getS3Client, getBucket, PutObjectCommand, GetObjectCommand, getSignedUrl } from './s3.client';

const LOG = '[BuiltInSkillService]';
const BUILT_IN_ROOT = path.join(process.cwd(), 'sdk/prismer-cloud/built-in-skills');

// release202/09 §3.3 — capability-stack governance.
//
// SYSTEM_SKILL_SLUGS = the "A-list" of system-capability built-ins. These are
// `isSystem=true` AND `defaultEnabled=true`: auto-installed onto every NEW
// agent. Everything else under built-in-skills/ is a "general" (B-list) skill —
// catalog-visible but `isSystem=false` / `defaultEnabled=false`, so the owner
// re-enables it one-by-one via /admin/skills.
//
// Keep this in sync with migration 456_v209_skill_system_default_flags.sql
// (the migration backfills the same partition for existing DBs; this constant
// seeds a fresh DB correctly without relying on the migration).
const SYSTEM_SKILL_SLUGS = new Set<string>([
  'agent-coordination',
  'agent-meta',
  'assets',
  'claim-agent-ownership',
  'human-approval',
  'image-generate',
  'ingest',
  'liteparse',
  'memory',
  'memory-curation',
  'office-artifacts',
  'prismer-im-collab',
  'skill-authoring',
  'tasks',
  'team',
]);

function isSystemSkillSlug(slug: string): boolean {
  return SYSTEM_SKILL_SLUGS.has(slug);
}

// v2.1 §A.7 — files we never package into the manifest:
//   • LICENSE.txt — surfaced via frontmatter.license, not as a payload file
//   • .DS_Store / Thumbs.db — macOS/Windows fs junk
//   • dotfiles — never user-actionable (Anthropic skills carry none)
const EXCLUDED_BASENAMES = new Set(['.DS_Store', 'Thumbs.db', 'LICENSE.txt', 'LICENSE', 'LICENSE.md']);
const SKILL_S3_KEY_PREFIX = 'skills'; // pro-prismer-slide/skills/<sha256>/<basename>
const SKILL_S3_URL_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export interface BuiltInSkillResource {
  slug: string;
  rootDir: string;
  skillMdPath: string;
  skillMd: string; // SKILL.md raw content (preserved for dual-write to IMSkill.content)
  fm: FrontmatterFields;
  fmErrors: string[];
  manifest: ManifestResult;
  fileCount: number;
  totalSize: number;
}

export class BuiltInSkillService {
  constructor(private agentSkillService: AgentSkillService) {}

  async readBuiltInSkillResources(root = BUILT_IN_ROOT): Promise<BuiltInSkillResource[]> {
    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = (await fs.readdir(root, { withFileTypes: true })) as any;
    } catch (err: any) {
      if (err?.code === 'ENOENT') return [];
      throw err;
    }

    const resources: BuiltInSkillResource[] = [];
    const inlineThreshold = getInlineThresholdBytes();
    const s3Enabled = isS3Available();
    const uploadLarge = s3Enabled
      ? async (file: ManifestFileInput, hash: string): Promise<{ url: string; s3Key: string }> => {
          const basename = path.basename(file.path);
          // Content-addressable key — re-uploads of same bytes are no-ops
          // (S3 idempotent PUT).
          const s3Key = `${SKILL_S3_KEY_PREFIX}/${hash}/${basename}`;
          const s3 = getS3Client();
          const bucket = getBucket();
          await s3.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: s3Key,
              Body: file.bytes,
              ContentType: guessContentType(basename),
              ContentLength: file.bytes.byteLength,
              Metadata: { sha256: hash, 'skill-path': file.path },
            }),
          );
          const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: s3Key }), {
            expiresIn: SKILL_S3_URL_TTL_SECONDS,
          });
          return { url, s3Key };
        }
      : undefined;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const slug = entry.name;
      const rootDir = path.join(root, slug);
      const skillMdPath = path.join(rootDir, 'SKILL.md');

      let skillMd: string;
      try {
        skillMd = await fs.readFile(skillMdPath, 'utf8');
      } catch (err: any) {
        // Skill dir without SKILL.md is non-conformant; skip silently to
        // preserve the previous behaviour (don't break upsert on partial
        // import).
        if (err?.code === 'ENOENT') continue;
        throw err;
      }

      const parsed = parseFrontmatter(skillMd);
      const fmErrors = [...parsed.errors, ...validateAgainstDirName(parsed.fm, slug)];

      const files = await collectSkillFiles(rootDir);
      if (fmErrors.length > 0) {
        console.warn(`${LOG} ${slug}: frontmatter warnings: ${fmErrors.join('; ')}`);
      }

      const manifest = await buildManifest(files, { inlineThresholdBytes: inlineThreshold, uploadLarge });
      const totalSize = files.reduce((s, f) => s + f.bytes.byteLength, 0);

      resources.push({
        slug,
        rootDir,
        skillMdPath,
        skillMd,
        fm: parsed.fm,
        fmErrors,
        manifest,
        fileCount: files.length,
        totalSize,
      });
    }

    return resources.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  async upsertBuiltInSkills(_workspaceId?: string | null) {
    const resources = await this.readBuiltInSkillResources();
    const skills = [];

    // Reconcile against the file-system source-of-truth: any previously-upserted
    // built-in whose SKILL.md is no longer present (e.g. the v2.0 21→6 skill
    // consolidation) gets flipped to `deprecated` so agents stop loading it.
    // Without this step the old fine-grained slugs would linger in im_skills
    // with status=active forever and ship into agent installs.
    const presentSlugs = new Set(resources.map((r) => r.slug));
    const existingBuiltIns = await prisma.iMSkill.findMany({
      where: { category: 'built-in', status: 'active' },
      select: { id: true, slug: true },
    });
    const orphanIds = existingBuiltIns
      .filter((s: { slug: string }) => !presentSlugs.has(s.slug))
      .map((s: { id: string }) => s.id);
    if (orphanIds.length > 0) {
      await prisma.iMSkill.updateMany({
        where: { id: { in: orphanIds } },
        data: { status: 'deprecated' },
      });
      console.log(`${LOG} Marked ${orphanIds.length} orphaned built-in skills as deprecated`);
    }

    for (const resource of resources) {
      const metadata = buildMetadata(resource);
      const description = pickDescription(resource);
      const name = pickDisplayName(resource);
      const compatibility = pickCompatibility(resource.fm);
      const license = pickLicense(resource.fm);
      const manifestJson = JSON.stringify(resource.manifest.files);
      // release202/09 §3.3 — A-list (system) vs B-list (general) classification.
      // All built-ins are isSystem=defaultEnabled for our catalog (system →
      // both true; general → both false); a future "system but off by default"
      // skill could diverge, but today the two flags move together.
      const isSystem = isSystemSkillSlug(resource.slug);
      const defaultEnabled = isSystem;

      const skill = await prisma.iMSkill.upsert({
        where: { slug: resource.slug },
        create: {
          slug: resource.slug,
          name,
          description,
          category: 'built-in',
          tags: JSON.stringify(['built-in']),
          author: 'Prismer',
          source: 'prismer',
          sourceUrl: '',
          sourceId: `built-in:${resource.slug}`,
          content: resource.skillMd, // dual-write — 6-month deprecation window
          contentManifest: manifestJson,
          contentManifestRevision: resource.manifest.revision,
          fileCount: resource.fileCount,
          packageSize: resource.totalSize,
          status: 'active',
          metadata: JSON.stringify(metadata),
          compatibility: JSON.stringify(compatibility),
          license,
          securityStatus: 'clean',
          isSystem,
          defaultEnabled,
        },
        update: {
          name,
          description,
          category: 'built-in',
          tags: JSON.stringify(['built-in']),
          author: 'Prismer',
          source: 'prismer',
          sourceId: `built-in:${resource.slug}`,
          content: resource.skillMd, // dual-write — daemon fallback during 6mo deprecation
          contentManifest: manifestJson,
          contentManifestRevision: resource.manifest.revision,
          fileCount: resource.fileCount,
          packageSize: resource.totalSize,
          status: 'active',
          metadata: JSON.stringify(metadata),
          compatibility: JSON.stringify(compatibility),
          license,
          securityStatus: 'clean',
          isSystem,
          defaultEnabled,
        },
      });
      skills.push(skill);
    }

    console.log(`${LOG} Upserted ${skills.length} built-in skills (multi-file manifest)`);
    return skills;
  }

  async ensureBuiltInsForWorkspace(workspaceId: string) {
    return this.upsertBuiltInSkills(workspaceId);
  }

  async installAllBuiltInsToAgent(agentId: string, workspaceId?: string | null) {
    const allSkills = await this.upsertBuiltInSkills(workspaceId);
    // Release 201 — test fixtures carry frontmatter
    // metadata.excludeFromDefaultInstall=true and must NOT be
    // auto-installed onto agents. They stay in the catalog so cookbook +
    // dev-loop can install them explicitly via /agent-skills/install.
    // (The original `multi-file-smoke` fixture was removed 2026-05-31;
    // the filter remains for any future test-only skill.)
    //
    // release202/09 §3.3 — ALSO gate on `defaultEnabled`. The default
    // auto-install set for a NEW agent is now ONLY the system (A-list)
    // built-ins (`defaultEnabled=true`), not the full catalog. General
    // (B-list) built-ins stay in the catalog and are enabled per-agent by
    // the owner via /admin/skills.
    //
    // NOTE: this only changes what gets auto-installed GOING FORWARD. The
    // install loop below never disables or removes already-installed rows on
    // existing agents — it only `installSkillToAgent`s genuinely-missing
    // defaultEnabled skills (see the `existingBySkillId.has` guard). So an
    // existing agent that already has B-list skills keeps them; we never
    // retroactively sweep them off. (The deprecated-sweep further down is a
    // separate, unchanged concern — it only removes installs pointing at
    // status='deprecated' built-ins.)
    const skills = allSkills.filter(
      (skill: { metadata: string | null; defaultEnabled: boolean }) =>
        skill.defaultEnabled && !isExcludedFromDefaultInstall(skill.metadata),
    );
    if (allSkills.length !== skills.length) {
      const skippedSlugs = allSkills
        .filter(
          (s: { metadata: string | null; defaultEnabled: boolean }) =>
            !s.defaultEnabled || isExcludedFromDefaultInstall(s.metadata),
        )
        .map((s: { slug: string }) => s.slug);
      console.log(
        `${LOG} Default-install set = ${skills.length} system skills; skipped ${skippedSlugs.length} non-default/test-only: ${skippedSlugs.join(', ')}`,
      );
    }
    const existingRows = await prisma.iMAgentSkill.findMany({
      where: { agentId, skillId: { in: skills.map((skill: { id: string }) => skill.id) } },
      select: { skillId: true, status: true },
    });
    const existingBySkillId = new Map(existingRows.map((row: { skillId: string; status: string }) => [row.skillId, row.status]));
    const installed = [];
    for (const skill of skills) {
      // Backfill only genuinely missing built-ins. A disabled/uninstalled row
      // is user intent and must not be silently re-enabled by daemon sync.
      if (existingBySkillId.has(skill.id)) continue;
      const result = await this.agentSkillService.installSkillToAgent(agentId, skill.id, {
        workspaceId: workspaceId ?? undefined,
      });
      installed.push(result.agentSkill);
    }
    // Sweep this agent's previously-installed rows that now point at
    // deprecated built-ins (e.g. the v2.0 21→6 consolidation). Leaving them
    // would re-sync deprecated SKILL.md content to the agent's disk on the
    // next dispatch.
    //
    // 2026-05-29 — 2-step query. IMAgentSkill schema doesn't declare a
    // `skill` relation field (only the raw `skillId` FK), so the original
    // nested `where: { skill: { category, status } }` syntax threw
    // "Invalid prisma.iMAgentSkill.findMany invocation" at runtime,
    // surfacing as a 500 from POST /api/im/agents/:id/skills/install-builtins
    // *after* the install loop above had already committed. Fix is to
    // resolve deprecated built-in IDs first, then filter agent installs by
    // skillId IN (...).
    const deprecatedBuiltInIds = await prisma.iMSkill.findMany({
      where: { category: 'built-in', status: 'deprecated' },
      select: { id: true },
    });
    const deprecatedInstalled = deprecatedBuiltInIds.length === 0
      ? []
      : await prisma.iMAgentSkill.findMany({
          where: { agentId, skillId: { in: deprecatedBuiltInIds.map((s: { id: string }) => s.id) } },
          select: { id: true, skillId: true },
        });
    if (deprecatedInstalled.length > 0) {
      await prisma.iMAgentSkill.deleteMany({
        where: { id: { in: deprecatedInstalled.map((r: { id: string }) => r.id) } },
      });
      console.log(
        `${LOG} Removed ${deprecatedInstalled.length} deprecated built-in installs for agent ${agentId.slice(-8)}`,
      );
    }
    console.log(`${LOG} Installed ${installed.length} missing built-in skills for agent ${agentId.slice(-8)}`);
    return installed;
  }
}

// ─── helpers ────────────────────────────────────────────────────────────

/**
 * Recursive directory walk that collects every file (excluding LICENSE.txt /
 * dotfiles / OS junk) into ManifestFileInput[]. Paths are POSIX-normalised
 * relative to the skill root so the daemon writes them verbatim.
 */
async function collectSkillFiles(rootDir: string): Promise<ManifestFileInput[]> {
  const out: ManifestFileInput[] = [];

  async function walk(dir: string, prefix: string) {
    const entries = (await fs.readdir(dir, { withFileTypes: true })) as Array<{
      name: string;
      isDirectory: () => boolean;
      isFile: () => boolean;
    }>;
    for (const entry of entries) {
      const name = entry.name;
      if (name.startsWith('.')) continue; // dotfiles
      if (EXCLUDED_BASENAMES.has(name)) continue;
      const fullPath = path.join(dir, name);
      const relPath = prefix ? `${prefix}/${name}` : name;
      if (entry.isDirectory()) {
        await walk(fullPath, relPath);
      } else if (entry.isFile()) {
        const bytes = await fs.readFile(fullPath);
        out.push({ path: relPath, bytes });
      }
    }
  }
  await walk(rootDir, '');
  // Deterministic ordering — sort by path. Without this the merkle root would
  // vary between runs depending on fs.readdir order.
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

function buildMetadata(resource: BuiltInSkillResource): Record<string, unknown> {
  return {
    source: 'built-in',
    builtIn: true,
    resourcePath: path.relative(process.cwd(), resource.rootDir),
    fileCount: resource.fileCount,
    manifestRevision: resource.manifest.revision,
    ...(resource.fm.metadata ? { frontmatterMetadata: resource.fm.metadata } : {}),
  };
}

/**
 * Release 201 — return true when the skill's frontmatter metadata marks
 * it as a test fixture that should NOT be part of the default agent install
 * set. Frontmatter shape:
 *
 *   metadata:
 *     testOnly: true                  # advisory — describes intent
 *     excludeFromDefaultInstall: true # operative — what installAll filters on
 *
 * `testOnly` alone is treated as exclusion for safety (anyone marking a
 * skill "test only" almost certainly does not want it auto-installed).
 */
function isExcludedFromDefaultInstall(metadataJson: string | null): boolean {
  if (!metadataJson) return false;
  try {
    const parsed = JSON.parse(metadataJson);
    const fm = parsed?.frontmatterMetadata;
    if (!fm || typeof fm !== 'object') return false;
    return fm.excludeFromDefaultInstall === true || fm.testOnly === true;
  } catch {
    return false;
  }
}

function pickDescription(resource: BuiltInSkillResource): string {
  const fmDesc = resource.fm.description?.trim();
  if (fmDesc) return fmDesc.slice(0, 1024);
  // Fallback: first non-empty, non-heading body line.
  const body = stripFrontmatter(resource.skillMd);
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  return (lines[0] ?? 'Prismer built-in skill').slice(0, 1024);
}

function pickDisplayName(resource: BuiltInSkillResource): string {
  const body = stripFrontmatter(resource.skillMd);
  const firstHeading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (firstHeading) return firstHeading;
  const fmName = resource.fm.name;
  if (fmName) return titleCase(fmName);
  return titleCase(resource.slug);
}

function pickCompatibility(fm: FrontmatterFields): string[] {
  const defaults = ['prismer-sdk', 'claude-code', 'codex'];
  if (!fm.compatibility) return defaults;
  if (typeof fm.compatibility === 'string') return [fm.compatibility];
  if (Array.isArray(fm.compatibility)) return fm.compatibility;
  return defaults;
}

function pickLicense(fm: FrontmatterFields): string {
  return fm.license?.trim() || 'Prismer-Internal';
}

function stripFrontmatter(content: string): string {
  const match = content.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/);
  if (!match) return content;
  return content.slice(match[0].length);
}

function titleCase(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function guessContentType(basename: string): string {
  const ext = path.extname(basename).toLowerCase();
  switch (ext) {
    case '.md':
      return 'text/markdown';
    case '.txt':
      return 'text/plain';
    case '.json':
      return 'application/json';
    case '.yaml':
    case '.yml':
      return 'application/x-yaml';
    case '.py':
      return 'text/x-python';
    case '.js':
    case '.mjs':
    case '.ts':
      return 'application/javascript';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.ttf':
      return 'font/ttf';
    case '.otf':
      return 'font/otf';
    case '.woff':
      return 'font/woff';
    case '.woff2':
      return 'font/woff2';
    case '.pdf':
      return 'application/pdf';
    case '.xml':
      return 'application/xml';
    default:
      return 'application/octet-stream';
  }
}

// Keep a small reference to `config` to avoid the unused-import warning when
// future extensions read s3.region/bucket explicitly. (No behaviour change.)
void config;

// Re-export for tests
export { collectSkillFiles, pickCompatibility, pickLicense, computeManifestRevision, sha256Hex };
