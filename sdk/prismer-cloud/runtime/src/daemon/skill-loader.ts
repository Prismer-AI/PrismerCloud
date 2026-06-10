import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import type { AgentProfile } from '../adapters/contract.js';

export interface SkillChange {
  slug: string;
  path: string;
}

export interface LoadedSkill {
  slug: string;
  path: string;
  content: string;
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
  constructor(private readonly skillsRoot: string | null) {}

  getSkillsRoot(): string | null {
    return this.skillsRoot;
  }

  async loadForDispatch(): Promise<LoadedSkill[]> {
    if (!this.skillsRoot) return [];
    return readSkillFiles(this.skillsRoot);
  }
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
      if (content.trim()) {
        skills.push({ slug: entry.name, path: skillPath, content: content.trim() });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return skills.sort((a, b) => a.slug.localeCompare(b.slug));
}

export function renderSkillsSystemPrompt(skills: LoadedSkill[]): string | undefined {
  if (skills.length === 0) return undefined;
  const blocks = skills.map((skill) => [`## ${skill.slug}`, skill.content].join('\n\n'));
  return ['[Installed Skills]', ...blocks].join('\n\n');
}
