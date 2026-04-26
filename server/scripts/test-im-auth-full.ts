/**
 * Full IM auth flow simulation.
 * Run: npx tsx scripts/test-im-auth-full.ts
 */
import jwt from 'jsonwebtoken';

async function test() {
  // Step 1: Generate IM token
  const secret = process.env.JWT_SECRET || process.env.NEXTAUTH_SECRET || 'dev-secret-change-me';
  console.log('Secret:', secret.slice(0, 15), `(${secret.length} chars)`);

  const imToken = jwt.sign({ sub: '461', username: '461', role: 'system' as const, type: 'api_key_proxy' }, secret, {
    expiresIn: '1h',
  });

  // Step 2: Boot IM server
  console.log('Booting IM server...');
  const { createApp } = await import('../src/im/server');
  const app = createApp();

  // Step 3: Call workspace API through Hono
  console.log('Calling workspace API...');
  const req = new Request('http://localhost/api/workspace?scope=global&slots=identity', {
    headers: {
      Authorization: `Bearer ${imToken}`,
      'Content-Type': 'application/json',
    },
  });

  const res = await app.fetch(req);
  const body = await res.text();
  console.log('Status:', res.status);
  console.log('Body:', body.slice(0, 500));
}

test().catch((e) => console.error('TOP ERROR:', e));
