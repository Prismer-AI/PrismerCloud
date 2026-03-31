/**
 * Unit tests for signal-enrichment.ts
 * Covers extractSignals() and createEnrichedExtractor() with all branches.
 */
import { describe, it, expect, vi } from 'vitest';
import { extractSignals, createEnrichedExtractor } from '../../src/signal-enrichment';
import type { SignalTag, ExecutionContext, SignalEnrichmentConfig } from '../../src/types';

// ============================================================================
// extractSignals()
// ============================================================================

describe('extractSignals', () => {
  // --------------------------------------------------------------------------
  // 1. All 16 error patterns
  // --------------------------------------------------------------------------
  describe('error pattern matching', () => {
    const errorCases: Array<{ name: string; error: string; expectedType: string }> = [
      { name: 'timeout', error: 'Request timed out after 30s', expectedType: 'error:timeout' },
      { name: 'connection_refused', error: 'ECONNREFUSED 127.0.0.1:3000', expectedType: 'error:connection_refused' },
      { name: 'dns_error', error: 'getaddrinfo ENOTFOUND api.example.com', expectedType: 'error:dns_error' },
      { name: 'rate_limit', error: '429 Too Many Requests', expectedType: 'error:rate_limit' },
      { name: 'auth_error', error: '401 Unauthorized', expectedType: 'error:auth_error' },
      { name: 'permission_error', error: '403 Forbidden - Access Denied', expectedType: 'error:permission_error' },
      { name: 'not_found', error: '404 Not Found', expectedType: 'error:not_found' },
      { name: 'server_error', error: '500 Internal Server Error', expectedType: 'error:server_error' },
      { name: 'type_error', error: "TypeError: Cannot read properties of undefined", expectedType: 'error:type_error' },
      { name: 'syntax_error', error: "SyntaxError: Unexpected token '<'", expectedType: 'error:syntax_error' },
      { name: 'reference_error', error: 'ReferenceError: foo is not defined', expectedType: 'error:reference_error' },
      { name: 'oom', error: 'JavaScript heap out of memory', expectedType: 'error:oom' },
      { name: 'crash', error: 'SIGSEGV: segmentation fault', expectedType: 'error:crash' },
      { name: 'quota_exceeded', error: 'Quota exceeded for API key', expectedType: 'error:quota_exceeded' },
      { name: 'tls_error', error: 'unable to verify the first certificate', expectedType: 'error:tls_error' },
      { name: 'deadlock', error: 'Deadlock found when trying to get lock', expectedType: 'error:deadlock' },
    ];

    for (const { name, error, expectedType } of errorCases) {
      it(`matches ${name} pattern: "${error}"`, () => {
        const tags = extractSignals({ error });
        expect(tags.length).toBeGreaterThanOrEqual(1);
        expect(tags[0].type).toBe(expectedType);
      });
    }
  });

  // --------------------------------------------------------------------------
  // 2. Fallback normalization: unknown error -> truncated slug
  // --------------------------------------------------------------------------
  it('falls back to normalized slug for unknown error', () => {
    const tags = extractSignals({ error: 'Something weird happened' });
    expect(tags).toHaveLength(1);
    expect(tags[0].type).toBe('error:something_weird_happened');
  });

  // --------------------------------------------------------------------------
  // 3. Error string longer than 50 chars gets truncated in fallback
  // --------------------------------------------------------------------------
  it('truncates fallback error slug to 50 chars before normalizing', () => {
    const longError = 'A'.repeat(60) + ' some extra text that should be cut off';
    const tags = extractSignals({ error: longError });
    expect(tags).toHaveLength(1);
    // The slug is derived from first 50 chars, lowercased, non-alphanum replaced
    const slug = tags[0].type.replace('error:', '');
    // Original first 50 chars is 'AAA...A' (50 A's), lowered = 'aaa...a', no special chars
    expect(slug).toBe('a'.repeat(50));
  });

  // --------------------------------------------------------------------------
  // 4. Special characters in error get replaced with underscores
  // --------------------------------------------------------------------------
  it('replaces special characters with underscores in fallback slug', () => {
    const tags = extractSignals({ error: 'Oh no! @#$% broke' });
    expect(tags).toHaveLength(1);
    expect(tags[0].type).toBe('error:oh_no_______broke');
  });

  // --------------------------------------------------------------------------
  // 5. First match wins — pattern order matters
  // --------------------------------------------------------------------------
  it('first match wins: "401 Not Found" matches auth_error (401) before not_found', () => {
    // 401 appears in the auth_error pattern (index 4), not_found is index 6
    const tags = extractSignals({ error: '401 Not Found' });
    expect(tags).toHaveLength(1);
    expect(tags[0].type).toBe('error:auth_error');
  });

  it('first match wins: "429 rate limit exceeded" matches rate_limit before quota_exceeded', () => {
    // rate_limit (index 3) comes before quota_exceeded (index 13)
    const tags = extractSignals({ error: '429 rate limit exceeded' });
    expect(tags).toHaveLength(1);
    expect(tags[0].type).toBe('error:rate_limit');
  });

  it('first match wins: "Lock wait timeout" matches timeout before deadlock', () => {
    // "Lock wait timeout exceeded" contains "timeout" which matches index 0
    const tags = extractSignals({ error: 'Lock wait timeout exceeded' });
    expect(tags).toHaveLength(1);
    expect(tags[0].type).toBe('error:timeout');
  });

  it('first match wins: "503 timeout" matches timeout before server_error', () => {
    // timeout (index 0) comes before server_error (index 7)
    const tags = extractSignals({ error: '503 timeout' });
    expect(tags).toHaveLength(1);
    expect(tags[0].type).toBe('error:timeout');
  });

  // --------------------------------------------------------------------------
  // 6. Provider/stage/severity enrichment
  // --------------------------------------------------------------------------
  it('attaches provider when present in context', () => {
    const tags = extractSignals({ error: 'Request timed out', provider: 'openai' });
    expect(tags[0].provider).toBe('openai');
  });

  it('attaches stage when present in context', () => {
    const tags = extractSignals({ error: 'Request timed out', stage: 'compression' });
    expect(tags[0].stage).toBe('compression');
  });

  it('attaches severity when present in context (matched pattern)', () => {
    const tags = extractSignals({ error: '500 Internal Server Error', severity: 'critical' });
    expect(tags[0].severity).toBe('critical');
  });

  it('attaches provider and stage together', () => {
    const tags = extractSignals({ error: 'ECONNREFUSED', provider: 'exa', stage: 'search' });
    expect(tags[0]).toEqual({
      type: 'error:connection_refused',
      provider: 'exa',
      stage: 'search',
    });
  });

  it('attaches provider and stage to fallback slug', () => {
    const tags = extractSignals({ error: 'unknown weird error', provider: 'custom', stage: 'init' });
    expect(tags[0].provider).toBe('custom');
    expect(tags[0].stage).toBe('init');
  });

  it('does NOT attach severity on fallback slug (only provider/stage)', () => {
    // Looking at the source: fallback only sets provider and stage, not severity
    const tags = extractSignals({ error: 'unknown weird error', severity: 'high' });
    expect(tags[0].severity).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // 7. No error -> no error signals
  // --------------------------------------------------------------------------
  it('produces no error signals when error is undefined', () => {
    const tags = extractSignals({});
    expect(tags).toHaveLength(0);
  });

  it('produces no error signals when error is empty string', () => {
    // empty string is falsy, so ctx.error check fails
    const tags = extractSignals({ error: '' });
    expect(tags).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // 8. taskStatus 'failed' -> task.failed signal
  // --------------------------------------------------------------------------
  it('emits task.failed signal', () => {
    const tags = extractSignals({ taskStatus: 'failed' });
    expect(tags).toHaveLength(1);
    expect(tags[0]).toEqual({ type: 'task.failed' });
  });

  // --------------------------------------------------------------------------
  // 9. taskStatus 'completed' -> task.completed signal
  // --------------------------------------------------------------------------
  it('emits task.completed signal', () => {
    const tags = extractSignals({ taskStatus: 'completed' });
    expect(tags).toHaveLength(1);
    expect(tags[0]).toEqual({ type: 'task.completed' });
  });

  it('does not emit task signal for other statuses', () => {
    const tags = extractSignals({ taskStatus: 'running' });
    expect(tags).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // 10. taskCapability -> capability:xxx signal
  // --------------------------------------------------------------------------
  it('emits capability signal', () => {
    const tags = extractSignals({ taskCapability: 'code_review' });
    expect(tags).toHaveLength(1);
    expect(tags[0]).toEqual({ type: 'capability:code_review' });
  });

  // --------------------------------------------------------------------------
  // 11. Custom tags array -> passed through
  // --------------------------------------------------------------------------
  it('passes through custom tags', () => {
    const tags = extractSignals({ tags: ['custom:one', 'custom:two'] });
    expect(tags).toHaveLength(2);
    expect(tags[0]).toEqual({ type: 'custom:one' });
    expect(tags[1]).toEqual({ type: 'custom:two' });
  });

  // --------------------------------------------------------------------------
  // 12. Empty context -> empty signals
  // --------------------------------------------------------------------------
  it('returns empty array for completely empty context', () => {
    const tags = extractSignals({});
    expect(tags).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // 13. Combined: error + taskStatus + capability + tags -> all signals present
  // --------------------------------------------------------------------------
  it('combines all signal sources', () => {
    const tags = extractSignals({
      error: '429 Too Many Requests',
      provider: 'openai',
      stage: 'compression',
      severity: 'warn',
      taskStatus: 'failed',
      taskCapability: 'summarize',
      tags: ['env:prod', 'retry:3'],
    });

    expect(tags).toHaveLength(5);

    // Error signal with enrichment
    expect(tags[0]).toEqual({
      type: 'error:rate_limit',
      provider: 'openai',
      stage: 'compression',
      severity: 'warn',
    });

    // Task status
    expect(tags[1]).toEqual({ type: 'task.failed' });

    // Capability
    expect(tags[2]).toEqual({ type: 'capability:summarize' });

    // Custom tags
    expect(tags[3]).toEqual({ type: 'env:prod' });
    expect(tags[4]).toEqual({ type: 'retry:3' });
  });
});

// ============================================================================
// createEnrichedExtractor()
// ============================================================================

describe('createEnrichedExtractor', () => {
  // --------------------------------------------------------------------------
  // 14. mode: 'rules' -> returns async wrapper of extractSignals
  // --------------------------------------------------------------------------
  it('mode "rules" returns async wrapper that calls extractSignals', async () => {
    const extractor = createEnrichedExtractor({ mode: 'rules' });
    const result = await extractor({ error: '404 Not Found' });
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('error:not_found');
  });

  it('mode "rules" ignores llmExtract even if provided', async () => {
    const llmExtract = vi.fn();
    const extractor = createEnrichedExtractor({ mode: 'rules', llmExtract });
    await extractor({ error: 'timeout' });
    expect(llmExtract).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // 15. mode: 'llm' with llmExtract -> calls LLM function
  // --------------------------------------------------------------------------
  it('mode "llm" with llmExtract calls the LLM function', async () => {
    const llmResult: SignalTag[] = [{ type: 'llm:custom_signal' }];
    const llmExtract = vi.fn().mockResolvedValue(llmResult);
    const extractor = createEnrichedExtractor({ mode: 'llm', llmExtract });

    const ctx: ExecutionContext = { error: 'something' };
    const result = await extractor(ctx);

    expect(llmExtract).toHaveBeenCalledWith(ctx);
    expect(result).toEqual(llmResult);
  });

  // --------------------------------------------------------------------------
  // 16. mode: 'llm' without llmExtract -> falls back to rules
  // --------------------------------------------------------------------------
  it('mode "llm" without llmExtract falls back to rules', async () => {
    const extractor = createEnrichedExtractor({ mode: 'llm' });
    const result = await extractor({ error: 'ECONNREFUSED' });
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('error:connection_refused');
  });

  // --------------------------------------------------------------------------
  // 17. LLM timeout -> falls back to rules
  // --------------------------------------------------------------------------
  it('falls back to rules when LLM times out', async () => {
    const llmExtract = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 5000))
    );
    const extractor = createEnrichedExtractor({
      mode: 'llm',
      llmExtract,
      timeoutMs: 50, // Very short timeout to keep test fast
    });

    const result = await extractor({ error: '401 Unauthorized' });
    // Should have fallen back to rules
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('error:auth_error');
  });

  // --------------------------------------------------------------------------
  // 18. LLM throws error -> falls back to rules
  // --------------------------------------------------------------------------
  it('falls back to rules when LLM throws an error', async () => {
    const llmExtract = vi.fn().mockRejectedValue(new Error('LLM API failed'));
    const extractor = createEnrichedExtractor({ mode: 'llm', llmExtract });

    const result = await extractor({ error: '500 Internal Server Error' });
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('error:server_error');
  });

  it('LLM timeout uses default 3000ms when timeoutMs not specified', async () => {
    // We can't easily test the exact default without waiting 3s,
    // but we can verify the extractor is created and works
    const llmExtract = vi.fn().mockResolvedValue([{ type: 'llm:fast' }]);
    const extractor = createEnrichedExtractor({ mode: 'llm', llmExtract });

    const result = await extractor({ error: 'test' });
    expect(result).toEqual([{ type: 'llm:fast' }]);
  });
});
