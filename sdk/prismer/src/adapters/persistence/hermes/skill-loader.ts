import type { AgentProfile } from '../../contract.js';
import type { AgentSlashCommand } from '../../coding/shared/index.js';
import { FileSystemSkillLoader, renderSkillsSystemPrompt, type SkillLoader } from '../../../daemon/skill-loader.js';
import { parse as parseYaml } from 'yaml';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { skillAvailabilityContextFromEnvFiles } from '../../../daemon/skill-availability.js';

function skillDescription(content: string, slug: string): string {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (frontmatter?.[1]) {
    try {
      const parsed = parseYaml(frontmatter[1]) as { description?: unknown } | null;
      if (typeof parsed?.description === 'string' && parsed.description.trim()) {
        return parsed.description.trim();
      }
    } catch {
      // A malformed frontmatter file remains invokable; use the fallback.
    }
  }
  return `Invoke the ${slug} skill`;
}

function normalizeSkillSlug(value: string): string {
  return value.toLowerCase().replace(/_/g, '-');
}

export class HermesSkillLoader implements SkillLoader {
  private readonly delegate: FileSystemSkillLoader;

  constructor(
    private readonly skillsRoot: string,
    private readonly configPath = join(dirname(skillsRoot), 'config.yaml'),
    private readonly envPaths = [join(dirname(configPath), '.env')],
  ) {
    this.delegate = new FileSystemSkillLoader(skillsRoot, () => this.availabilityContext());
  }

  getSkillsRoot(): string {
    return this.skillsRoot;
  }

  private async availabilityContext() {
    const context = skillAvailabilityContextFromEnvFiles(this.envPaths);
    try {
      const config = parseYaml(await readFile(this.configPath, 'utf8'));
      context.disabled = Array.isArray(config?.skills?.disabled) ? config.skills.disabled : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return context;
  }

  async loadForDispatch(profile?: AgentProfile) {
    return this.delegate.loadForDispatch(profile);
  }

  async loadSystemPromptFragment(profile?: AgentProfile): Promise<string | undefined> {
    return renderSkillsSystemPrompt(await this.loadForDispatch(profile));
  }

  async listCommands(): Promise<AgentSlashCommand[]> {
    const skills = await this.loadForDispatch();
    return skills.map((skill) => ({
      name: skill.slug,
      description: skillDescription(skill.content, skill.slug),
      argumentHint: '[instruction]',
      kind: 'skill' as const,
    }));
  }

  /** Expand `/skill-slug args` exactly like Hermes CLI's skill dispatcher. */
  async expandSlashInvocation(prompt: string): Promise<string | null> {
    const match = /^\/([a-zA-Z0-9][a-zA-Z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(prompt.trim());
    if (!match) return null;
    const requested = normalizeSkillSlug(match[1]!);
    const skill = (await this.loadForDispatch()).find((candidate) => normalizeSkillSlug(candidate.slug) === requested);
    if (!skill) return null;
    const instruction = match[2]?.trim() ?? '';
    return [
      `[IMPORTANT: The user invoked the "${skill.slug}" skill. Follow its instructions for this turn.]`,
      '',
      skill.content,
      ...(instruction ? ['', `User instruction: ${instruction}`] : []),
    ].join('\n');
  }
}
