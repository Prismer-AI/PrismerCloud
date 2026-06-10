import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildRoleTemplateMigrationPlan, readPacks } from '../../../scripts/migrate-role-templates';

describe('ACP role template migration drift checks', () => {
  it('fresh MySQL migration creates im_role_templates with ACP columns and strict-safe TEXT columns', () => {
    const sql = readFileSync('src/im/sql/325_v54_role_templates.sql', 'utf8');

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS `im_role_templates`');
    expect(sql).toContain('`operatingPrinciples`  TEXT NULL');
    expect(sql).toContain("`taskAuthority`        VARCHAR(20) NOT NULL DEFAULT 'executor'");
    expect(sql).toContain("`approvalPolicy`       VARCHAR(20) NOT NULL DEFAULT 'auto-low-risk'");
    expect(sql).toContain('`mcpServers`           TEXT NOT NULL');
    expect(sql).not.toMatch(/TEXT\s+NOT NULL\s+DEFAULT/i);
  });

  it('forward drift migration repairs old ACP table/approval drift without replaying prior migrations', () => {
    const sql = readFileSync('src/im/sql/327_v54_acp_drift_fix.sql', 'utf8');

    expect(sql).toContain('CREATE PROCEDURE _327_add_col_if_missing');
    expect(sql).toContain("'im_approvals'");
    expect(sql).toContain("'updatedAt'");
    expect(sql).toContain('DROP TABLE IF EXISTS `role_templates`');
    expect(sql).not.toContain('DROP TABLE IF EXISTS `im_role_templates`');
  });

  it('builds an idempotent role-template import plan from docs/54release/template without touching Prisma', async () => {
    const plan = buildRoleTemplateMigrationPlan(await readPacks());
    const slugs = plan.map((template) => template.slug);

    expect(plan.length).toBeGreaterThan(20);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs).toContain('ceo');
    expect(slugs).toContain('engineer');

    for (const template of plan) {
      expect(template.status).toBe('active');
      // v2.1 (release 201) — legacy `skill_sync` alias removed; only
      // `prismer.skill.sync` remains. Negative + positive assertions
      // so future re-introductions trip this test loudly.
      expect(template.mcpServers[0]?.toolsAllowlist).not.toContain('skill_sync');
      expect(template.mcpServers[0]?.toolsAllowlist).toContain('prismer.skill.sync');
    }
  });
});
