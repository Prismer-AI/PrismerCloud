import type { AgentProfile } from '../contract.js';
import { FileSystemSkillLoader, renderSkillsSystemPrompt, type SkillLoader } from '../../daemon/skill-loader.js';

export class HermesSkillLoader implements SkillLoader {
  private readonly delegate: FileSystemSkillLoader;

  constructor(private readonly skillsRoot: string) {
    this.delegate = new FileSystemSkillLoader(skillsRoot);
  }

  getSkillsRoot(): string {
    return this.skillsRoot;
  }

  async loadForDispatch(profile?: AgentProfile) {
    void profile;
    return this.delegate.loadForDispatch();
  }

  async loadSystemPromptFragment(profile?: AgentProfile): Promise<string | undefined> {
    return renderSkillsSystemPrompt(await this.loadForDispatch(profile));
  }
}
