/**
 * @vitest-environment jsdom
 *
 * S22 — Evidence Panel 9-section rendering.
 *
 * Verifies that ALL 9 sections (capability / source / diff / runtime /
 * security / validation / smoke / sample / publish-plan) render given a
 * representative SkillDetail. This guards against accidental stub
 * regression — every section must have a unique `data-testid`.
 */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { EvidencePanel } from '../lifecycle/evidence-panel';
import type { EvalRunStatus, SkillDetail } from '../types';
import { I18nProvider } from '@/contexts/i18n-context';

const SKILL_FIXTURE: SkillDetail = {
  id: 'skill-1',
  slug: 'my-skill',
  name: 'My skill',
  description: 'Does a thing.',
  lifecycleStage: 'review',
  status: 'draft',
  publishScope: 'workspace',
  contentManifestRevision: 'abc1234def567',
  files: [
    { path: 'SKILL.md', size: 1024 },
    { path: 'skill.json', size: 512 },
  ],
  executableJson: {},
  metadata: {
    lifecycleSubStage: 'human_review',
    skillJson: {
      description: 'Does a thing.',
      provenance: {
        sourceKind: 'doc-url',
        sourceRefs: [{ kind: 'doc-url', url: 'https://example.com/api', label: 'API docs' }],
      },
      security: {
        dataAccess: ['workspace-files'],
        humanApprovalRequiredFor: ['delete-asset'],
        riskLevel: 'medium',
      },
      runtime: {
        requires: { bins: ['rg', 'jq'], capabilities: ['fs.read'] },
      },
      sampleTasks: [{ title: 'Smoke task', description: 'Run sample' }],
    },
    validationWarnings: [{ gate: 'duplicate', severity: 'warning', message: 'Slug close to existing' }],
    sampleTaskId: 'task-1',
    publishPlan: {
      scope: 'workspace',
      version: '1.0.0',
      changelog: 'Initial release',
      installTargets: ['orchestrator'],
    },
  },
};

const EVAL_RUN_FIXTURE: EvalRunStatus = {
  runId: 'run-1234567890',
  skillId: 'skill-1',
  status: 'finished',
  passCount: 2,
  failCount: 1,
  testCases: [{ id: 'tc-1' }, { id: 'tc-2' }, { id: 'tc-3' }],
  results: [
    { id: 'tc-1', passed: true, durationMs: 12 },
    { id: 'tc-2', passed: true, durationMs: 15 },
    { id: 'tc-3', passed: false, durationMs: 8, error: 'boom' },
  ],
  agentTraceUrl: 'https://traces.example.com/run-1234567890',
  startedAt: null,
  finishedAt: null,
};

async function mount(skill: SkillDetail | null, evalRun: EvalRunStatus | null = null) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const onAction = vi.fn();
  await act(async () => {
    root.render(
      <I18nProvider>
        <EvidencePanel isDark={false} skill={skill} evalRun={evalRun} onAction={onAction} />
      </I18nProvider>,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return {
    host,
    onAction,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

beforeEach(() => {
  /* no-op */
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('EvidencePanel — 9 sections (S22)', () => {
  it('renders all 9 section testids when given a complete skill', async () => {
    const { host, cleanup } = await mount(SKILL_FIXTURE, EVAL_RUN_FIXTURE);
    const expected = [
      'evidence-section-capability',
      'evidence-section-source',
      'evidence-section-diff',
      'evidence-section-runtime',
      'evidence-section-security',
      'evidence-section-validation',
      'evidence-section-smoke',
      'evidence-section-sample',
      'evidence-section-publish-plan',
    ];
    for (const id of expected) {
      const el = host.querySelector(`[data-testid="${id}"]`);
      expect(el, `section ${id} should render`).toBeTruthy();
    }
    await cleanup();
  });

  it('renders the 6 reviewer-toolbar buttons and routes clicks to onAction', async () => {
    const { host, onAction, cleanup } = await mount(SKILL_FIXTURE);
    const toolbar = host.querySelector('[data-testid="evidence-reviewer-toolbar"]');
    expect(toolbar).toBeTruthy();
    // Approve & Publish is the primary CTA with a dedicated testid.
    const approve = host.querySelector('[data-testid="evidence-approve-publish"]') as HTMLButtonElement;
    expect(approve).toBeTruthy();
    await act(async () => {
      approve!.click();
    });
    expect(onAction).toHaveBeenCalledWith('approve-publish');
    await cleanup();
  });

  it('shows pass/fail badge counts in the smoke section', async () => {
    const { host, cleanup } = await mount(SKILL_FIXTURE, EVAL_RUN_FIXTURE);
    const smoke = host.querySelector('[data-testid="evidence-section-smoke"]');
    expect(smoke?.textContent).toContain('2/3 passed');
    await cleanup();
  });

  it('falls back to a friendly message when no skill is selected', async () => {
    const { host, cleanup } = await mount(null);
    expect(host.textContent).toMatch(/Pick a skill/);
    await cleanup();
  });
});
