import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { assessSkillAvailability, skillFrontmatter, type SkillAvailabilityContext } from './skill-availability.js';
import type { AgentProfile } from '../adapters/contract.js';
import { categoryForAdapter, skillScopeMatchesCategory, type SkillScope } from '../adapters/agent-category.js';

export interface SkillChange {
  slug: string;
  path: string;
}

export interface LoadedSkill {
  slug: string;
  path: string;
  content: string;
  /** doc release203/09 §7.6 — parsed from SKILL.md frontmatter; defaults to 'common'. */
  scope: SkillScope;
  /** product204/09 §2.1 — declared config keys (frontmatter `config:` block); [] when none. */
  config: SkillConfigDeclaration[];
}

/**
 * product204/09 §2.1 — one skill config declaration as seen daemon-side.
 * Values are RESOLVED cloud-side and arrive per dispatch via
 * `task.metadata.skillConfigEnv` (see adapters/prismer-env.ts); the daemon
 * only needs the declared shape (key names / requiredness) for diagnostics.
 */
export interface SkillConfigDeclaration {
  key: string;
  type: 'string' | 'secret' | 'url' | 'enum';
  required: boolean;
  default: string | null;
  bindable: Array<'global' | 'role' | 'agent'>;
}

export interface SkillLoader {
  /** Adapter-specific skills root. Null means the adapter does not support skill loading. */
  getSkillsRoot(profile?: AgentProfile): string | null;

  /** Optional adapter hook for reload-aware runtimes. File-watching runtimes can no-op. */
  onSkillsChanged?(profile: AgentProfile, changes: SkillChange[]): Promise<void>;

  /** Read dispatch-time SKILL.md files from the adapter's skills root. */
  loadForDispatch(profile?: AgentProfile): Promise<LoadedSkill[]>;
}

export class FileSystemSkillLoader implements SkillLoader {
  constructor(
    private readonly skillsRoot: string | null,
    private readonly availabilityContext?: () => Promise<SkillAvailabilityContext>,
  ) {}

  getSkillsRoot(): string | null {
    return this.skillsRoot;
  }

  async loadForDispatch(profile?: AgentProfile): Promise<LoadedSkill[]> {
    if (!this.skillsRoot) return [];
    const context = await this.availabilityContext?.();
    const skills = (await readSkillFiles(this.skillsRoot)).filter(
      (skill) => assessSkillAvailability(skill.content, context).status === 'available',
    );
    // doc release203/09 §7.6.3 — persistence agents load only `common` + their
    // own scope. Unknown adapter (null category) or no profile → no filtering,
    // so a missing/unrecognized scope can never silently drop a skill.
    const category = categoryForAdapter(profile?.adapterName);
    if (!category) return skills;
    return skills.filter((skill) => skillScopeMatchesCategory(skill.scope, category));
  }
}

/**
 * Extract `scope` from a SKILL.md YAML frontmatter block. Defaults to 'common'
 * when absent or unrecognized (forward-compat: user skills without scope are
 * always included). Scans ONLY within the first `---...---` block so quoted /
 * multi-line descriptions outside it cannot match.
 */
export function parseSkillScope(content: string): SkillScope {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!fm?.[1]) return 'common';
  const m = /^scope:\s*(common|persistence|coding|runtime-engine)\s*$/m.exec(fm[1]);
  return (m?.[1] as SkillScope) ?? 'common';
}

/**
 * product204/09 §2.1 — extract the `config:` declaration list from a SKILL.md
 * frontmatter block. Lenient mirror of the cloud's canonical parser
 * (src/im/skills/frontmatter.ts::parseSkillConfigDeclarations): malformed or
 * PRISMER_-prefixed entries are silently dropped (the cloud ingest gate is
 * the enforcing face; daemon-side this is diagnostic metadata only — resolved
 * VALUES arrive via task.metadata.skillConfigEnv, never from local parsing).
 */
export function parseSkillConfig(content: string): SkillConfigDeclaration[] {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!fm?.[1]) return [];
  let parsed: unknown;
  try {
    parsed = parseYaml(fm[1]);
  } catch {
    return [];
  }
  const config = (parsed as { config?: unknown } | null)?.config;
  if (!Array.isArray(config)) return [];
  const out: SkillConfigDeclaration[] = [];
  const types = new Set(['string', 'secret', 'url', 'enum']);
  const bindables = new Set(['global', 'role', 'agent']);
  for (const entry of config) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    const key = typeof rec.key === 'string' ? rec.key.trim() : '';
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key) || key.startsWith('PRISMER_')) continue;
    const type =
      typeof rec.type === 'string' && types.has(rec.type) ? (rec.type as SkillConfigDeclaration['type']) : 'string';
    const def = rec.default == null ? null : String(rec.default);
    const bindable =
      Array.isArray(rec.bindable) && rec.bindable.every((b) => typeof b === 'string' && bindables.has(b))
        ? ([...new Set(rec.bindable)] as SkillConfigDeclaration['bindable'])
        : (['global', 'role', 'agent'] as SkillConfigDeclaration['bindable']);
    out.push({ key, type, required: rec.required === true && def === null, default: def, bindable });
  }
  return out;
}

export async function readSkillFiles(skillsRoot: string): Promise<LoadedSkill[]> {
  let entries;
  try {
    entries = await fsp.readdir(skillsRoot, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const skills: LoadedSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(skillsRoot, entry.name, 'SKILL.md');
    try {
      const content = await fsp.readFile(skillPath, 'utf8');
      const trimmed = content.trim();
      if (trimmed) {
        skills.push({
          slug: entry.name,
          path: skillPath,
          content: trimmed,
          scope: parseSkillScope(trimmed),
          config: parseSkillConfig(trimmed),
        });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  // Hidden compatibility aliases carry the canonical frontmatter name. Prefer
  // the canonical directory when both survived an older profile sync.
  const byName = new Map<string, LoadedSkill>();
  for (const skill of skills.sort((a, b) => a.slug.localeCompare(b.slug))) {
    let name = skill.slug;
    try {
      name = skillFrontmatter(skill.content).name ?? name;
    } catch {
      /* diagnostics handles malformed YAML */
    }
    const existing = byName.get(name);
    if (existing && existing.content !== skill.content) {
      byName.set(skill.path, skill); // differing user skills are not compatibility aliases
    } else if (!existing || skill.slug === name) byName.set(name, skill);
  }
  return [...byName.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

export function renderSkillsSystemPrompt(skills: LoadedSkill[]): string | undefined {
  if (skills.length === 0) return undefined;
  const blocks = skills.map((skill) => [`## ${skill.slug}`, skill.content].join('\n\n'));
  return ['[Installed Skills]', ...blocks].join('\n\n');
}
