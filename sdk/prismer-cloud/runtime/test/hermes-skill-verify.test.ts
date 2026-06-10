// release201/26 §13.3 #3 — verifyHermesSkillLoaded probe.
//
// Asserts the four outcome branches of the GET /v1/skills verify probe:
//   - slug present in data[].name        → 'loaded', no console.error
//   - slug absent                          → 'missing', loud console.error
//   - skills_api capability absent/false   → 'skipped', no fetch, no error
//   - fetch throws / non-2xx               → 'probe_failed', non-blocking
//
// Pure function over (baseUrl, apiKey, slug, capabilities); we mock global
// fetch — no real hermes spawn.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyHermesSkillLoaded } from '../src/adapters/hermes/index.js';

const SLUG = 'prismer-im-collab';
const BASE = 'http://127.0.0.1:8642';
const KEY = 'sk-hermes-test';

function mockSkillsResponse(names: string[], status = 200): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ object: 'list', data: names.map((name) => ({ name })) }),
  } as unknown as Response);
}

describe('verifyHermesSkillLoaded', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Silence + capture the [metric]/log stderr lines.
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function metricLines(): string[] {
    return stderrSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('[metric] hermes_skill_verify_total'));
  }

  it('returns "loaded" with no console.error when slug is present', async () => {
    mockSkillsResponse([SLUG, 'some-other-skill']);
    const r = await verifyHermesSkillLoaded(BASE, KEY, SLUG, { skills_api: true });
    expect(r).toBe('loaded');
    expect(errSpy).not.toHaveBeenCalled();
    expect(metricLines().some((l) => l.includes('result=loaded'))).toBe(true);
  });

  it('returns "missing" with a loud console.error when slug is absent', async () => {
    mockSkillsResponse(['some-other-skill']);
    const r = await verifyHermesSkillLoaded(BASE, KEY, SLUG, { skills_api: true });
    expect(r).toBe('missing');
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0]![0])).toContain('NOT loaded by hermes');
    expect(metricLines().some((l) => l.includes('result=missing'))).toBe(true);
  });

  it('returns "skipped" without fetching when skills_api is not advertised', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await verifyHermesSkillLoaded(BASE, KEY, SLUG, { skills_api: false });
    expect(r).toBe('skipped');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    expect(metricLines().some((l) => l.includes('result=skipped'))).toBe(true);
  });

  it('returns "skipped" when capabilities is undefined (older hermes)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await verifyHermesSkillLoaded(BASE, KEY, SLUG, undefined);
    expect(r).toBe('skipped');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns "probe_failed" (non-blocking) when fetch throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await verifyHermesSkillLoaded(BASE, KEY, SLUG, { skills_api: true });
    expect(r).toBe('probe_failed');
    expect(errSpy).not.toHaveBeenCalled();
    expect(metricLines().some((l) => l.includes('result=probe_failed'))).toBe(true);
  });

  it('returns "probe_failed" on a non-2xx response', async () => {
    mockSkillsResponse([], 500);
    const r = await verifyHermesSkillLoaded(BASE, KEY, SLUG, { skills_api: true });
    expect(r).toBe('probe_failed');
    expect(metricLines().some((l) => l.includes('result=probe_failed'))).toBe(true);
  });
});
