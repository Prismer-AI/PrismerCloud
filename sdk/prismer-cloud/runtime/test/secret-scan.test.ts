import { describe, it, expect } from 'vitest';
import { scanForSecrets, hasBlockingSecret } from '../src/secret-scan.js';

describe('secret-scan — pattern detection', () => {
  it('detects AWS access keys', () => {
    const hits = scanForSecrets('AKIAABCDEFGHIJKLMNOP is the key');
    expect(hits.some((h) => h.pattern === 'aws-access-key')).toBe(true);
  });

  it('detects Prismer live API keys', () => {
    const hits = scanForSecrets('key=sk-prismer-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef');
    expect(hits.some((h) => h.pattern === 'prismer-api-key')).toBe(true);
  });

  it('detects Stripe live keys', () => {
    const hits = scanForSecrets('STRIPE_KEY=sk_live_abcdefghij0123456789AB');
    expect(hits.some((h) => h.pattern === 'stripe-live-key')).toBe(true);
  });

  it('detects Stripe test keys', () => {
    const hits = scanForSecrets('STRIPE_TEST=sk_test_abcdefghij0123456789AB');
    expect(hits.some((h) => h.pattern === 'stripe-test-key')).toBe(true);
  });

  it('detects OpenAI project keys', () => {
    const key = 'sk-proj-' + 'a'.repeat(48);
    const hits = scanForSecrets(`OPENAI=${key}`);
    expect(hits.some((h) => h.pattern === 'openai-project-key')).toBe(true);
  });

  it('detects all 5 GitHub token flavors', () => {
    const body = [
      'ghp_' + 'a'.repeat(36),
      'gho_' + 'b'.repeat(36),
      'ghu_' + 'c'.repeat(36),
      'ghs_' + 'd'.repeat(36),
      'ghr_' + 'e'.repeat(36),
    ].join('\n');
    const hits = scanForSecrets(body);
    const kinds = new Set(hits.map((h) => h.pattern));
    expect(kinds.has('github-token-pat')).toBe(true);
    expect(kinds.has('github-token-oauth')).toBe(true);
    expect(kinds.has('github-token-user')).toBe(true);
    expect(kinds.has('github-token-server')).toBe(true);
    expect(kinds.has('github-token-refresh')).toBe(true);
  });

  it('detects Slack tokens', () => {
    const hits = scanForSecrets('slack=xoxb-12345-abcdefghij');
    expect(hits.some((h) => h.pattern === 'slack-token')).toBe(true);
  });

  it('detects PEM private key blocks (RSA / EC / OPENSSH / bare)', () => {
    const samples = [
      '-----BEGIN RSA PRIVATE KEY-----',
      '-----BEGIN EC PRIVATE KEY-----',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      '-----BEGIN PRIVATE KEY-----',
    ];
    for (const s of samples) {
      const hits = scanForSecrets(s + '\nMII...');
      expect(hits.some((h) => h.pattern === 'private-key-block')).toBe(true);
    }
  });

  it('emits JWT hits but marks them warnOnly', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.AbCdEfGhIjKlMnOp-_aB';
    const hits = scanForSecrets(`Bearer ${jwt}`);
    const jwtHit = hits.find((h) => h.pattern === 'jwt');
    expect(jwtHit).toBeDefined();
    expect(jwtHit!.warnOnly).toBe(true);
  });

  it('hasBlockingSecret treats JWT-only as non-blocking', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.AbCdEfGhIjKlMnOp-_aB';
    expect(hasBlockingSecret(jwt)).toBe(false);
  });

  it('hasBlockingSecret is true when any hard pattern hits', () => {
    expect(hasBlockingSecret('AKIAABCDEFGHIJKLMNOP')).toBe(true);
    expect(hasBlockingSecret('ghp_' + 'a'.repeat(36))).toBe(true);
  });

  it('gives correct line numbers', () => {
    const body = 'line 1\nline 2\nAKIAABCDEFGHIJKLMNOP\nline 4';
    const hits = scanForSecrets(body);
    const aws = hits.find((h) => h.pattern === 'aws-access-key');
    expect(aws?.line).toBe(3);
  });

  it('never echoes full match longer than 80 chars', () => {
    const key = 'sk-proj-' + 'x'.repeat(200);
    const hits = scanForSecrets(key);
    const oai = hits.find((h) => h.pattern === 'openai-project-key');
    expect(oai).toBeDefined();
    expect(oai!.match.length).toBeLessThanOrEqual(80);
  });
});

describe('secret-scan — no false positives on clean markdown', () => {
  it('empty string → no hits', () => {
    expect(scanForSecrets('').length).toBe(0);
  });

  it('README-style text → no hits', () => {
    const md = `# Project Widget

A friendly little utility.

## Setup

1. Clone the repo
2. Run \`npm install\`
3. Invoke \`widget --help\`

## License

MIT. See LICENSE.md.
`;
    const hits = scanForSecrets(md);
    expect(hits.length).toBe(0);
  });

  it('code snippets with normal variables → no hits', () => {
    const md = `\`\`\`ts
const user = { id: 'abc123', email: 'user@example.com' };
const api_key_env = process.env.API_KEY; // never hardcode!
\`\`\``;
    const hits = scanForSecrets(md);
    expect(hits.length).toBe(0);
  });

  it('base64-ish data → no hits', () => {
    const md = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=';
    const hits = scanForSecrets(md);
    expect(hits.length).toBe(0);
  });

  it('short sk- inside a word → no generic-sk hit', () => {
    const md = 'This task-link is fine: no-sk-just-words-here and sk-shortone (only 8 chars after sk-)';
    const hits = scanForSecrets(md);
    expect(hits.length).toBe(0);
  });
});
