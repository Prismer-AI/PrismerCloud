/**
 * Diagnose IM auth issue in dev mode.
 * Run: npx tsx scripts/test-im-auth.ts
 */
import jwt from 'jsonwebtoken';

async function test() {
  // Step 1: Load Nacos config (same as apiGuard does)
  const { ensureNacosConfig } = await import('../src/lib/nacos-config');
  await ensureNacosConfig();

  const secret1 = process.env.JWT_SECRET || process.env.NEXTAUTH_SECRET || 'dev-secret-change-me';
  console.log('apiGuard secret:', secret1.slice(0, 15) + '...', `(${secret1.length} chars)`);

  // Step 2: IM config secret (same getter)
  const { config } = await import('../src/im/config');
  const secret2 = config.jwt.secret;
  console.log('IM config secret:', secret2.slice(0, 15) + '...', `(${secret2.length} chars)`);
  console.log('Match:', secret1 === secret2);

  // Step 3: Generate IM token (same as generateIMTokenForUser)
  const imToken = jwt.sign({ sub: '461', username: '461', role: 'system' as const, type: 'api_key_proxy' }, secret1, {
    expiresIn: '1h',
  });
  console.log('\nGenerated IM token:', imToken.slice(0, 60) + '...');

  // Step 4: Verify (same as IM authMiddleware)
  try {
    const payload = jwt.verify(imToken, secret2);
    console.log('Verify OK:', JSON.stringify(payload));
  } catch (e: any) {
    console.log('Verify FAILED:', e.message);
  }

  // Step 5: Also check if standalone IM server uses a different secret
  console.log(
    '\nprocess.env.JWT_SECRET:',
    process.env.JWT_SECRET ? process.env.JWT_SECRET.slice(0, 15) + '...' : '(not set)',
  );
  console.log('process.env.NEXTAUTH_SECRET:', process.env.NEXTAUTH_SECRET ? 'set' : '(not set)');
}

test().catch(console.error);
