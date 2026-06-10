/**
 * release201/20 Gap B (v2.0.8 Wave 1 F2) — onboarding 6-step + i18n.
 *
 * Asserts the 18 onboarding.* keys all resolve in en + zh and never fall back
 * to the raw key. Other locales (de/fr/es) fall back to en via translate() so
 * we only enforce the source-of-truth pair.
 */
import { describe, test, expect } from 'vitest';
import { translate } from '@/lib/i18n';

const ONBOARDING_KEYS = [
  'workspace.onboarding.title',
  'workspace.onboarding.subtitle',
  'workspace.onboarding.step.team.label',
  'workspace.onboarding.step.team.detail',
  'workspace.onboarding.step.agent.label',
  'workspace.onboarding.step.agent.detailEmpty',
  'workspace.onboarding.step.agent.detailCount',
  'workspace.onboarding.step.project.label',
  'workspace.onboarding.step.project.detail',
  'workspace.onboarding.step.device.label',
  'workspace.onboarding.step.device.detail',
  'workspace.onboarding.step.session.label',
  'workspace.onboarding.step.session.detail',
  'workspace.onboarding.step.task.label',
  'workspace.onboarding.step.task.detail',
  'workspace.onboarding.step.asset.label',
  'workspace.onboarding.step.asset.detail',
] as const;

describe('onboarding i18n keys', () => {
  test('exactly 17 declared keys plus subtitle interpolation', () => {
    // 17 named keys; subtitle uses two vars (done, total). Asset step kept in
    // dictionary for backward compat even though removed from render order.
    expect(ONBOARDING_KEYS.length).toBe(17);
  });

  test('all keys resolve in en (no raw-key fallback)', () => {
    for (const key of ONBOARDING_KEYS) {
      const value = translate('en', key as never, { n: 1, done: 0, total: 6 });
      expect(value, `en key missing: ${key}`).not.toBe(key);
      expect(value.length).toBeGreaterThan(0);
    }
  });

  test('all keys resolve in zh (no raw-key fallback)', () => {
    for (const key of ONBOARDING_KEYS) {
      const value = translate('zh', key as never, { n: 1, done: 0, total: 6 });
      expect(value, `zh key missing: ${key}`).not.toBe(key);
      expect(value.length).toBeGreaterThan(0);
    }
  });

  test('subtitle interpolates {done}/{total} in both locales', () => {
    const en = translate('en', 'workspace.onboarding.subtitle' as never, { done: 3, total: 6 });
    const zh = translate('zh', 'workspace.onboarding.subtitle' as never, { done: 3, total: 6 });
    expect(en).toContain('3');
    expect(en).toContain('6');
    expect(zh).toContain('3');
    expect(zh).toContain('6');
    // Should not leak raw placeholders
    expect(en).not.toContain('{done}');
    expect(en).not.toContain('{total}');
    expect(zh).not.toContain('{done}');
    expect(zh).not.toContain('{total}');
  });

  test('agent detailCount interpolates {n}', () => {
    const en = translate('en', 'workspace.onboarding.step.agent.detailCount' as never, { n: 4 });
    const zh = translate('zh', 'workspace.onboarding.step.agent.detailCount' as never, { n: 4 });
    expect(en).toContain('4');
    expect(zh).toContain('4');
  });

  test('non-en/zh locales fall back to en (no raw-key leak)', () => {
    for (const locale of ['de', 'fr', 'es'] as const) {
      for (const key of ONBOARDING_KEYS) {
        const value = translate(locale, key as never, { n: 1, done: 0, total: 6 });
        expect(value, `${locale} fallback failed for: ${key}`).not.toBe(key);
        expect(value.length).toBeGreaterThan(0);
      }
    }
  });
});
