/**
 * release201/20 Gap C残余 (v2.0.8 Wave 1 F3) — insights surface i18n.
 *
 * audit reality (this audit replaces doc 20 §0 estimate of "2 keys + ~5"):
 * insights-surface.tsx had ≥25 hardcoded English strings — not 2. F3 ships the
 * full sweep: surface chrome (title, subtitle, refresh, shortcuts), view tabs,
 * range picker (presets + custom modal + clear), shortcut help modal, and the
 * formatRelativeTime relative-timestamp strings.
 *
 * Source-of-truth locales are en + zh; de/fr/es are also populated but the
 * harness only enforces en/zh (matches the i18n-onboarding test convention,
 * see src/lib/__tests__/i18n-onboarding.test.ts).
 *
 * Acceptance covers two contracts:
 *  1. every new workspace.insights.* key resolves to a real translated
 *     string (≠ key) under both en and zh, with interpolation populated;
 *  2. insights-surface.tsx contains zero hardcoded JSX text matching the
 *     audit grep — the same grep used during the F3 audit step.
 */

import { describe, test, expect } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';

import { translate } from '@/lib/i18n';

const INSIGHTS_KEYS = [
  'workspace.insights.title',
  'workspace.insights.subtitle.overview',
  'workspace.insights.subtitle.project',
  'workspace.insights.subtitle.agent',
  'workspace.insights.updatedRelative',
  'workspace.insights.refresh',
  'workspace.insights.refreshHint',
  'workspace.insights.shortcuts',
  'workspace.insights.shortcutsHint',
  'workspace.insights.view.overview',
  'workspace.insights.view.project',
  'workspace.insights.view.agent',
  'workspace.insights.range.aria',
  'workspace.insights.range.custom',
  'workspace.insights.range.customDialogAria',
  'workspace.insights.range.customTitle',
  'workspace.insights.range.customHint',
  'workspace.insights.range.clearAria',
  'workspace.insights.range.from',
  'workspace.insights.range.to',
  'workspace.insights.range.invalid',
  'workspace.insights.range.cancel',
  'workspace.insights.range.apply',
  'workspace.insights.shortcutHelp.last24h',
  'workspace.insights.shortcutHelp.last7d',
  'workspace.insights.shortcutHelp.last30d',
  'workspace.insights.shortcutHelp.last90d',
  'workspace.insights.shortcutHelp.refresh',
  'workspace.insights.shortcutHelp.toggle',
  'workspace.insights.lastUpdated.justNow',
  'workspace.insights.lastUpdated.secAgo',
  'workspace.insights.lastUpdated.minAgo',
  'workspace.insights.lastUpdated.hourAgo',
  'workspace.insights.lastUpdated.dayAgo',
] as const;

const INTERP_VALUES = { count: 5, relative: '5 min ago', from: '2026-05-01', to: '2026-05-28' };

describe('insights i18n — F3 audit-driven sweep', () => {
  test('all keys resolve in en (no raw-key fallback)', () => {
    for (const key of INSIGHTS_KEYS) {
      const value = translate('en', key as never, INTERP_VALUES);
      expect(value, `en miss: ${key}`).toBeTruthy();
      expect(value, `en raw key returned: ${key}`).not.toBe(key);
    }
  });

  test('all keys resolve in zh (no raw-key fallback, real localization)', () => {
    // "Agent" is a transliterated/brand term — zh dictionary keeps "Agent" verbatim
    // (matches existing zh keys like workspace.profile.agent = 'Agent', see
    // src/lib/i18n.ts). Same for view.agent / subtitle.agent.
    const ZH_EN_EQUAL_ALLOWED = new Set([
      'workspace.insights.view.agent',
      'workspace.insights.subtitle.agent', // contains 'Agent' brand word — translated
    ]);
    for (const key of INSIGHTS_KEYS) {
      const value = translate('zh', key as never, INTERP_VALUES);
      expect(value, `zh miss: ${key}`).toBeTruthy();
      expect(value, `zh raw key returned: ${key}`).not.toBe(key);
      if (ZH_EN_EQUAL_ALLOWED.has(key)) continue;
      // zh must differ from en for non-brand keys (i.e. real translation, not en-tunneling)
      const en = translate('en', key as never, INTERP_VALUES);
      expect(value, `zh equals en for ${key} — translation missing`).not.toBe(en);
    }
  });

  test('interpolation populates {count} / {relative} / {from} / {to}', () => {
    const cases: Array<[string, keyof typeof INTERP_VALUES, string]> = [
      ['workspace.insights.updatedRelative', 'relative', String(INTERP_VALUES.relative)],
      ['workspace.insights.lastUpdated.secAgo', 'count', String(INTERP_VALUES.count)],
      ['workspace.insights.lastUpdated.minAgo', 'count', String(INTERP_VALUES.count)],
      ['workspace.insights.lastUpdated.hourAgo', 'count', String(INTERP_VALUES.count)],
      ['workspace.insights.lastUpdated.dayAgo', 'count', String(INTERP_VALUES.count)],
      ['workspace.insights.range.customTitle', 'from', String(INTERP_VALUES.from)],
      ['workspace.insights.range.customTitle', 'to', String(INTERP_VALUES.to)],
    ];
    for (const [key, , expectedSub] of cases) {
      const en = translate('en', key as never, INTERP_VALUES);
      const zh = translate('zh', key as never, INTERP_VALUES);
      expect(en, `en interp missing in ${key}`).toContain(expectedSub);
      expect(zh, `zh interp missing in ${key}`).toContain(expectedSub);
    }
  });
});

describe('insights-surface.tsx — no hardcoded English chrome', () => {
  // Resolve from repo root regardless of vitest cwd.
  const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
  const filePath = 'src/app/workspace/components/insights/insights-surface.tsx';

  test('grep returns 0 hardcoded JSX text / aria / title attrs', () => {
    // grep -c returns exit=1 when zero matches; we ignore exit and count matches
    // by reading stderr separately. Pipe via `printf 0` fallback only on grep
    // exit=1 (no matches) → output is single "0" line.
    const cmd =
      `(grep -E '>[A-Z][a-zA-Z]+( [a-zA-Z]+){0,3}<|aria-label="[A-Z]|title="[A-Z]' ` +
      `${filePath} || true) | wc -l | tr -d ' '`;
    const out = execSync(cmd, { cwd: repoRoot, encoding: 'utf8' }).trim();
    const count = Number(out);
    expect(Number.isFinite(count), `unexpected wc-l output: ${JSON.stringify(out)}`).toBe(true);
    expect(count, `audit grep found ${count} hardcoded strings in ${filePath}`).toBe(0);
  });
});
