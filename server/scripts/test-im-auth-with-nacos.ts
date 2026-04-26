/**
 * Simulate the EXACT Next.js dev flow to find the JWT_SECRET mismatch.
 * Run: APP_ENV=test npx tsx scripts/test-im-auth-with-nacos.ts
 */
import jwt from 'jsonwebtoken';

async function test() {
  // Force APP_ENV to test (same as the user's dev environment likely connects to)
  process.env.APP_ENV = process.env.APP_ENV || 'test';
  console.log('APP_ENV:', process.env.APP_ENV);

  // Step 1: BEFORE Nacos
  const secretBefore = process.env.JWT_SECRET || '(not set)';
  console.log('\n--- BEFORE ensureNacosConfig ---');
  console.log('JWT_SECRET:', secretBefore);

  // Step 2: Load Nacos (this is what apiGuard does on first request)
  const { ensureNacosConfig } = await import('../src/lib/nacos-config');
  await ensureNacosConfig();

  // Step 3: AFTER Nacos
  const secretAfter = process.env.JWT_SECRET || '(not set)';
  console.log('\n--- AFTER ensureNacosConfig ---');
  console.log(
    'JWT_SECRET:',
    secretAfter === '(not set)' ? '(not set)' : secretAfter.slice(0, 20) + `... (${secretAfter.length} chars)`,
  );

  if (secretAfter !== '(not set)' && secretAfter !== secretBefore) {
    console.log('\n!!! Nacos CHANGED JWT_SECRET !!!');
    console.log('This means: IM server started with fallback secret, but apiGuard uses Nacos secret');
    console.log('generateIMTokenForUser signs with:', secretAfter.slice(0, 15));
    console.log('IM verifyToken verifies with:', (process.env.JWT_SECRET || 'dev-secret-change-me').slice(0, 15));

    // Test the mismatch
    const imToken = jwt.sign({ sub: '461', username: '461', role: 'system', type: 'api_key_proxy' }, secretAfter, {
      expiresIn: '1h',
    });
    const imSecret = process.env.JWT_SECRET || process.env.NEXTAUTH_SECRET || 'dev-secret-change-me';

    try {
      jwt.verify(imToken, imSecret);
      console.log('Verify with Nacos secret: OK');
    } catch (e: any) {
      console.log('Verify with Nacos secret: FAILED -', e.message);
    }

    // Now try with fallback
    try {
      jwt.verify(imToken, 'dev-secret-change-me');
      console.log('Verify with fallback secret: OK');
    } catch (e: any) {
      console.log('Verify with fallback secret: FAILED -', e.message);
    }
  } else {
    console.log('JWT_SECRET unchanged — secrets should match');
  }
}

test().catch(console.error);
