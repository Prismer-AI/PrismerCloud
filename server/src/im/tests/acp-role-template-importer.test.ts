import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildImportPlan,
  buildOperatingPrinciples,
  extractAgencyPrinciples,
  isIncrementalTemplateUnchanged,
  parseArgs,
  splitSoulAndAgents,
} from '../../../scripts/methodology/import-agency-agents';

const fixtureDir = path.resolve(process.cwd(), 'scripts/methodology/__fixtures__/agency-agents');

describe('agency role template importer', () => {
  it('builds role template import rows from local agency-agents markdown', async () => {
    const templates = await buildImportPlan({
      sourceDir: fixtureDir,
      importedAt: new Date('2026-05-18T00:00:00.000Z'),
    });

    expect(templates).toHaveLength(1);
    expect(templates[0]).toMatchObject({
      slug: 'frontend-developer',
      source: 'agency-agents',
      sourceSlug: 'engineering/frontend-developer',
      curatedQuality: 'silver',
      category: 'engineering',
      agentType: 'specialist',
      taskAuthority: 'executor',
      metadata: {
        source: 'agency-agents',
        sourceSlug: 'engineering/frontend-developer',
        license: 'MIT',
        curation: { tier: 'silver' },
      },
    });
    expect(templates[0]!.operatingPrinciples.map((segment) => segment.source)).toEqual(['agency', '30-acp']);
    expect(templates[0]!.operatingPrinciples[0]!.text).toContain('Critical Rules');
    expect(templates[0]!.operatingPrinciples[1]!.text).toContain('request_human_approval');
    expect(templates[0]!.hermesConfig.soul).toContain('Your Identity & Memory');
    expect(templates[0]!.hermesConfig.agents).toContain('Your Core Mission');
  });

  it('lets CLI quality tier override source quality metadata', async () => {
    const templates = await buildImportPlan({
      sourceDir: fixtureDir,
      qualityTier: 'gold',
      importedAt: new Date('2026-05-18T00:00:00.000Z'),
    });

    expect(templates[0]!.curatedQuality).toBe('gold');
    expect(templates[0]!.metadata).toMatchObject({ curation: { tier: 'gold' } });
  });

  it('parses incremental import mode and rejects cleanup in incremental mode', () => {
    expect(parseArgs(['--mode=incremental'])).toMatchObject({ mode: 'incremental' });
    expect(parseArgs(['--incremental'])).toMatchObject({ mode: 'incremental' });
    expect(() => parseArgs(['--mode=incremental', '--deactivate-missing'])).toThrow(
      '--deactivate-missing is only valid with --mode=full',
    );
  });

  it('skips unchanged incremental rows only when both source commits match', () => {
    expect(isIncrementalTemplateUnchanged({ sourceCommit: 'abc123' }, { sourceCommit: 'abc123' })).toBe(true);
    expect(isIncrementalTemplateUnchanged({ sourceCommit: 'def456' }, { sourceCommit: 'abc123' })).toBe(false);
    expect(isIncrementalTemplateUnchanged({ sourceCommit: null }, { sourceCommit: 'abc123' })).toBe(false);
    expect(isIncrementalTemplateUnchanged({ sourceCommit: 'abc123' }, { sourceCommit: null })).toBe(false);
  });

  it('ignores repository docs and workflow examples that are not role templates', async () => {
    const templates = await buildImportPlan({
      sourceDir: fixtureDir,
      importedAt: new Date('2026-05-18T00:00:00.000Z'),
    });

    expect(templates.map((template) => template.slug)).toEqual(['frontend-developer']);
  });

  it('extracts agency critical rules and splits adapter prompt bodies', () => {
    const markdown = [
      '# Role',
      '',
      'Intro.',
      '',
      '## Your Identity & Memory',
      '',
      '- Remember constraints.',
      '',
      '## Critical Rules',
      '',
      '- Do the critical thing.',
      '',
      '## Deliverables',
      '',
      '- Ship notes.',
    ].join('\n');

    expect(extractAgencyPrinciples(markdown)).toContain('Do the critical thing.');
    const split = splitSoulAndAgents(markdown);
    expect(split.soul).toContain('Your Identity & Memory');
    expect(split.soul).toContain('Critical Rules');
    expect(split.agents).toContain('Deliverables');
  });

  it('degrades operating principles over 4KB by preserving the global fallback and truncating agency text', () => {
    const segments = buildOperatingPrinciples('x'.repeat(5000));

    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ source: 'agency' });
    expect(segments[1]).toMatchObject({ source: '30-acp' });
    expect(segments[1]!.text).toContain('request_human_approval');
    expect(segments[0]!.text.length + segments[1]!.text.length).toBeLessThanOrEqual(4096);
  });
});
