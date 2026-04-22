/**
 * Skill Loader — 6-level priority resolution (PARA §4.6.3.2).
 *
 * Search order, highest priority wins (later entries override earlier):
 *   1. workspace  — <ws>/skills/
 *   2. project    — <ws>/.prismer/skills/
 *   3. user       — ~/.prismer/skills/
 *   4. managed    — /etc/prismer/skills/ (enterprise MDM)
 *   5. plugin     — each plugin's own skills/ dir (namespaced <plugin>:<skill>)
 *   6. bundled    — adapter-provided (lowest)
 *
 * For a given skill name, the first hit wins. Plugin skills are namespaced
 * so they can't collide with workspace/user skills.
 *
 * The loader does NOT read skill bodies eagerly — only metadata (L0 in the
 * progressive disclosure model). The body (L1) is read by the caller via
 * `loadSkillBody(skill)` when the skill is actually activated.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseSkillMarkdown } from './frontmatter.js';

export type SkillSourceKind = 'workspace' | 'project' | 'user' | 'managed' | 'plugin' | 'bundled';

export interface SkillSource {
  kind: SkillSourceKind;
  root: string;        // absolute path to the search root
  pluginName?: string; // only for kind: 'plugin'
}

export interface SkillDescriptor {
  name: string;
  source: SkillSource;
  filePath: string;              // absolute path to SKILL.md
  frontmatter: Record<string, unknown>;
  /** Displayable name: `<plugin>:<skill>` for plugin sources, `<skill>` otherwise. */
  qualifiedName: string;
}

export interface LoaderOptions {
  workspace: string;
  home?: string;                  // override for tests; defaults to os.homedir()
  pluginRoots?: string[];         // each entry is a plugin dir (contains skills/)
  bundledRoots?: string[];        // adapter-provided roots
  managed?: string;               // override /etc/prismer/skills
}

/** Build the ordered source list for a given workspace. Highest priority first. */
export function defaultSkillSources(opts: LoaderOptions): SkillSource[] {
  const home = opts.home ?? (process.env['HOME'] ?? '');
  const sources: SkillSource[] = [
    { kind: 'workspace', root: path.join(opts.workspace, 'skills') },
    { kind: 'project', root: path.join(opts.workspace, '.prismer', 'skills') },
    { kind: 'user', root: path.join(home, '.prismer', 'skills') },
    { kind: 'managed', root: opts.managed ?? '/etc/prismer/skills' },
  ];
  for (const p of opts.pluginRoots ?? []) {
    sources.push({ kind: 'plugin', root: path.join(p, 'skills'), pluginName: path.basename(p) });
  }
  for (const b of opts.bundledRoots ?? []) {
    sources.push({ kind: 'bundled', root: b });
  }
  return sources;
}

/** Enumerate all skill descriptors visible to this loader. Duplicates by name
 *  are resolved by priority (first hit wins, except plugin skills which are
 *  namespaced and can coexist). */
export function discoverSkills(opts: LoaderOptions): SkillDescriptor[] {
  const sources = defaultSkillSources(opts);
  const byName = new Map<string, SkillDescriptor>();

  for (const source of sources) {
    if (!fs.existsSync(source.root)) continue;
    for (const skill of listSkillsInSource(source)) {
      // Plugin skills always land under a namespaced key so they don't clash
      // with workspace/user skills of the same short name.
      const key = source.kind === 'plugin'
        ? `${source.pluginName}:${skill.name}`
        : skill.name;
      if (!byName.has(key)) {
        byName.set(key, { ...skill, qualifiedName: key });
      }
    }
  }

  return Array.from(byName.values());
}

/** Find a single skill by qualified name. Returns null if not found. */
export function findSkill(qualifiedName: string, opts: LoaderOptions): SkillDescriptor | null {
  const all = discoverSkills(opts);
  return all.find((s) => s.qualifiedName === qualifiedName || s.name === qualifiedName) ?? null;
}

/** Read the body of a skill (L1 in progressive disclosure). */
export function loadSkillBody(descriptor: SkillDescriptor): string {
  const source = fs.readFileSync(descriptor.filePath, 'utf-8');
  const { body } = parseSkillMarkdown(source);
  return body;
}

// ────────────────────────────────────────────────────────────────────────

function listSkillsInSource(source: SkillSource): Omit<SkillDescriptor, 'qualifiedName'>[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(source.root, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: Omit<SkillDescriptor, 'qualifiedName'>[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const skillDir = path.join(source.root, e.name);
    const skillFile = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;

    try {
      const text = fs.readFileSync(skillFile, 'utf-8');
      const { frontmatter } = parseSkillMarkdown(text);
      // Skill name comes from frontmatter.name, falls back to directory name.
      const name = typeof frontmatter['name'] === 'string'
        ? frontmatter['name'] as string
        : e.name;
      skills.push({
        name,
        source,
        filePath: skillFile,
        frontmatter,
      });
    } catch {
      // Malformed SKILL.md → skip silently. `prismer agent skill audit` is the
      // user-facing tool that surfaces these; the loader stays lenient.
    }
  }
  return skills;
}
