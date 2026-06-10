import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileSystemSkillLoader, renderSkillsSystemPrompt } from '../src/daemon/skill-loader.js';

describe('FileSystemSkillLoader', () => {
  it('loads SKILL.md files from a skills root for dispatch injection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prismer-skill-loader-'));
    try {
      mkdirSync(join(root, 'alpha'), { recursive: true });
      mkdirSync(join(root, 'beta'), { recursive: true });
      writeFileSync(join(root, 'alpha', 'SKILL.md'), '# Alpha\n\nUse alpha.', 'utf8');
      writeFileSync(join(root, 'beta', 'SKILL.md'), '# Beta\n\nUse beta.', 'utf8');

      const loader = new FileSystemSkillLoader(root);
      const skills = await loader.loadForDispatch();
      const prompt = renderSkillsSystemPrompt(skills);

      expect(loader.getSkillsRoot()).toBe(root);
      expect(skills.map((skill) => skill.slug)).toEqual(['alpha', 'beta']);
      expect(prompt).toContain('[Installed Skills]');
      expect(prompt).toContain('# Alpha');
      expect(prompt).toContain('# Beta');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
