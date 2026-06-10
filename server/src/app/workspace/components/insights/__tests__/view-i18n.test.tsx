/**
 * release201 v2.0.8 F3-fix — Insights view body i18n coverage.
 *
 * Verifies (a) every widget/empty key added for overview/project/agent
 * views resolves to a non-empty string in en + zh and is **not** a
 * silent fallback to the key path, and (b) the 3 view tsx files no
 * longer contain any hardcoded `title=`/`subtitle=`/`message=`/
 * `emptyHint=` prop strings (grep audit).
 */

import { describe, expect, test } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { translate, type TranslationKey } from '@/lib/i18n';

const WIDGET_KEYS: TranslationKey[] = [
  'workspace.insights.widget.tasksCompleted',
  'workspace.insights.widget.tasksCompletedSub',
  'workspace.insights.widget.topCapabilities',
  'workspace.insights.widget.topCapabilitiesSub',
  'workspace.insights.widget.acceptancePassRate',
  'workspace.insights.widget.acceptancePassRateSub',
  'workspace.insights.widget.deliveryTimeline',
  'workspace.insights.widget.deliveryTimelineSub',
  'workspace.insights.widget.memoryHotspots',
  'workspace.insights.widget.memoryHotspotsSub',
  'workspace.insights.widget.acceptanceStatus',
  'workspace.insights.widget.workbenchMap',
  'workspace.insights.widget.openTasks',
  'workspace.insights.widget.acceptance',
  'workspace.insights.widget.daysUntilArchive',
  'workspace.insights.widget.burndown',
  'workspace.insights.widget.burndownSub',
  'workspace.insights.widget.acceptanceByCapability',
  'workspace.insights.widget.activeMembers',
  'workspace.insights.widget.activityRange',
  'workspace.insights.widget.activityRangeSub',
  'workspace.insights.widget.tasksInRange',
  'workspace.insights.widget.tasksInRangeSub',
  'workspace.insights.widget.tasksByStatus',
  'workspace.insights.widget.tasksByStatusSub',
  'workspace.insights.widget.activityTimeline',
  'workspace.insights.widget.activityTimelineSub',
  'workspace.insights.widget.contributors',
  'workspace.insights.widget.contributorsSub',
  'workspace.insights.widget.recentFailedTasks',
  'workspace.insights.widget.pendingApprovals',
  'workspace.insights.widget.tasksDone',
  'workspace.insights.widget.dispatchLatencyP95',
  'workspace.insights.widget.acceptanceRate',
  'workspace.insights.widget.skillsUsed',
  'workspace.insights.widget.dispatchVolume',
  'workspace.insights.widget.dispatchVolumeSub',
  'workspace.insights.widget.skillInvocation',
  'workspace.insights.widget.skillInvocationSub',
  'workspace.insights.widget.recentTasks',
];

const EMPTY_KEYS: TranslationKey[] = [
  'workspace.insights.empty.pickWorkspace',
  'workspace.insights.empty.noActivity',
  'workspace.insights.empty.pickProject',
  'workspace.insights.empty.noMetricData',
  'workspace.insights.empty.pickAgent',
  'workspace.insights.empty.noData',
  'workspace.insights.empty.metricNotIngested',
  'workspace.insights.empty.noAcceptance',
  'workspace.insights.empty.projectNoTasks',
  'workspace.insights.empty.noActiveMembers',
  'workspace.insights.empty.noActivityInRange',
  'workspace.insights.empty.dispatchMetricNotIngested',
];

describe('insights view body i18n — en + zh resolve', () => {
  for (const k of [...WIDGET_KEYS, ...EMPTY_KEYS]) {
    test(`${k} resolves non-empty in en + zh and differs from key path`, () => {
      const en = translate('en', k, k.endsWith('Sub') ? { range: '7d' } : {});
      const zh = translate('zh', k, k.endsWith('Sub') ? { range: '7d' } : {});
      expect(en).toBeTruthy();
      expect(en).not.toBe(k);
      expect(zh).toBeTruthy();
      expect(zh).not.toBe(k);
      // zh should be a real translation, not an en fallback.
      expect(zh).not.toBe(en);
    });
  }
});

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..', '..');
const VIEW_FILES = [
  'src/app/workspace/components/insights/overview-view.tsx',
  'src/app/workspace/components/insights/project-view.tsx',
  'src/app/workspace/components/insights/agent-view.tsx',
];

describe('insights view body — hardcoded prop strings grep audit', () => {
  for (const rel of VIEW_FILES) {
    test(`${rel} has zero hardcoded title|subtitle|message|emptyHint props`, () => {
      // -c => count; -E for ERE alternation. grep -c emits "0" for no
      // matches but exits non-zero, so swallow the exit and use only its
      // stdout. (We can't pipe via `|| echo 0` because that would append
      // a second "0" line and break Number().)
      let out = '0';
      try {
        out = execSync(`grep -cE '(title|subtitle|message|emptyHint)=["'"'"'][A-Z]' ${rel}`, {
          cwd: REPO_ROOT,
          encoding: 'utf8',
        }).trim();
      } catch (err) {
        // grep exit 1 = no match (count was printed to stdout, but execSync
        // throws on non-zero). Read it off the error object.
        const stdout = (err as { stdout?: Buffer | string }).stdout;
        out = (typeof stdout === 'string' ? stdout : (stdout?.toString() ?? '0')).trim() || '0';
      }
      expect(Number(out)).toBe(0);
    });
  }
});
