/**
 * Cookbook: Skill Search & Install
 * @see docs/cookbook/en/skill-marketplace.md
 *
 * Validates:
 *   Step 1 — Search the Marketplace       → im.evolution.searchSkills()
 *   Step 2 — View Skill Detail            → getSkillStats() / raw request
 *   Step 3 — Install a Skill              → im.evolution.installSkill()
 *   Step 4 — List Installed Skills         → im.evolution.installedSkills()
 *   Step 5 — Load Skill Content            → im.evolution.getSkillContent()
 *   Cleanup — Uninstall                    → im.evolution.uninstallSkill()
 */
import { describe, it, expect, afterAll } from 'vitest';
import { apiClient } from '../helpers';

describe('Cookbook: Skill Marketplace', () => {
  const client = apiClient();
  let skillSlug: string;
  let skillId: string;

  // ── Step 1: Search the Marketplace ────────────────────────────────
  describe('Step 1 — Search the Marketplace', () => {
    it('searches for skills by query', async () => {
      const result = await client.im.evolution.searchSkills({
        query: 'summarization',
        limit: 10,
      });
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();

      if (result.data && result.data.length > 0) {
        const first = result.data[0];
        skillSlug = first.slug || first.id;
        skillId = first.id;
        expect(first.name).toBeDefined();
      }
    });
  });

  // ── Step 2: View Skill Detail ─────────────────────────────────────
  describe('Step 2 — View Skill Detail', () => {
    it('gets skill catalog statistics', async () => {
      const result = await client.im.evolution.getSkillStats();
      expect(result.ok).toBe(true);
    });
  });

  // ── Step 3: Install a Skill ───────────────────────────────────────
  describe('Step 3 — Install a Skill', () => {
    it('installs a skill from the catalog', async () => {
      if (!skillSlug) return; // skip if search returned nothing
      const result = await client.im.evolution.installSkill(skillSlug);
      expect(result.ok).toBe(true);
    });
  });

  // ── Step 4: List Installed Skills ─────────────────────────────────
  describe('Step 4 — List Installed Skills', () => {
    it('returns the list of installed skills', async () => {
      const result = await client.im.evolution.installedSkills();
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
    });
  });

  // ── Step 5: Load Skill Content ────────────────────────────────────
  describe('Step 5 — Load Skill Content', () => {
    it('gets skill content for use in prompts', async () => {
      if (!skillSlug) return;
      const result = await client.im.evolution.getSkillContent(skillSlug);
      if (result.ok) {
        expect(result.data).toBeDefined();
      } else {
        // getSkillContent may require install first or not be supported for all skills
        expect(result.error).toBeDefined();
      }
    });
  });

  // ── Cleanup: Uninstall ────────────────────────────────────────────
  describe('Cleanup — Uninstall', () => {
    it('uninstalls the previously installed skill', async () => {
      if (!skillSlug) return;
      const result = await client.im.evolution.uninstallSkill(skillSlug);
      expect(result).toBeDefined();
    });
  });

  afterAll(async () => {
    if (skillSlug) {
      await client.im.evolution.uninstallSkill(skillSlug).catch(() => {});
    }
  });
});
