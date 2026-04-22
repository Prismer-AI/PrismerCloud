/**
 * secret-scan — local-side secret detection for memory team sync.
 *
 * Mirror of src/im/services/memory/team-sync.service.ts SECRET_PATTERNS.
 * Kept in sync by convention — if you add a pattern there, add it here.
 *
 * Used by memory-team-sync.ts before POSTing bytes to the server (so secrets
 * never leave the device). Server has its own independent scanner (defense
 * in depth).
 *
 * Design: docs/version190/14e-memory-cc-compat.md §8.5
 */

export interface SecretHit {
  /** Pattern name (e.g. 'aws-access-key'). */
  pattern: string;
  /** Truncated match (never more than 80 chars — no full secret echo). */
  match: string;
  /** 1-based line number. */
  line: number;
  /**
   * If true, this hit is informational only — not strong enough evidence
   * to block a push on its own (e.g. JWT-shaped strings).
   */
  warnOnly: boolean;
}

interface SecretPatternDef {
  name: string;
  re: RegExp;
  warnOnly?: boolean;
}

const PATTERNS: ReadonlyArray<SecretPatternDef> = [
  { name: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/g },
  // Prismer keys look like `sk-prismer-live-<64-hex>` or `sk-prismer-test-<...>`.
  // Allow hyphens in the body so the `live-` / `test-` segment is tolerated.
  { name: 'prismer-api-key', re: /sk-prismer-[a-zA-Z0-9_-]{20,}/g },
  { name: 'stripe-live-key', re: /sk_live_[a-zA-Z0-9]{20,}/g },
  { name: 'stripe-test-key', re: /sk_test_[a-zA-Z0-9]{20,}/g },
  { name: 'openai-project-key', re: /sk-proj-[a-zA-Z0-9_-]{48,}/g },
  // Generic `sk-...` — must come AFTER sk-prismer-/sk-proj-; lookbehind avoids
  // re-matching inside a just-captured specific token.
  { name: 'generic-sk-key', re: /(?<![a-zA-Z0-9_-])sk-[a-zA-Z0-9]{20,}/g },
  { name: 'github-token-pat', re: /ghp_[a-zA-Z0-9]{36}/g },
  { name: 'github-token-oauth', re: /gho_[a-zA-Z0-9]{36}/g },
  { name: 'github-token-user', re: /ghu_[a-zA-Z0-9]{36}/g },
  { name: 'github-token-server', re: /ghs_[a-zA-Z0-9]{36}/g },
  { name: 'github-token-refresh', re: /ghr_[a-zA-Z0-9]{36}/g },
  { name: 'slack-token', re: /xox[baprs]-[a-zA-Z0-9-]{10,}/g },
  { name: 'private-key-block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |)PRIVATE KEY-----/g },
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, warnOnly: true },
];

/** Scan content for known secret patterns. Returns the list of hits. */
export function scanForSecrets(content: string): SecretHit[] {
  const hits: SecretHit[] = [];
  if (!content) return hits;

  const lineOffsets: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) lineOffsets.push(i + 1);
  }

  const offsetToLine = (off: number): number => {
    for (let i = lineOffsets.length - 1; i >= 0; i--) {
      if (lineOffsets[i] <= off) return i + 1;
    }
    return 1;
  };

  for (const { name, re, warnOnly } of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      hits.push({
        pattern: name,
        match: m[0].slice(0, 80),
        line: offsetToLine(m.index),
        warnOnly: warnOnly === true,
      });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }

  return hits;
}

/**
 * Convenience: true if content has at least one blocking (non-warnOnly) hit.
 */
export function hasBlockingSecret(content: string): boolean {
  return scanForSecrets(content).some((h) => !h.warnOnly);
}
