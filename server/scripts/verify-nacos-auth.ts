/**
 * Read-only Nacos auth-config verifier.
 *
 * Usage:
 *   APP_ENV=dev  npx tsx scripts/verify-nacos-auth.ts
 *   APP_ENV=test npx tsx scripts/verify-nacos-auth.ts
 *   APP_ENV=prod npx tsx scripts/verify-nacos-auth.ts
 *
 * Loads the env-appropriate Nacos namespace + dataId `PrismerCloud`,
 * inspects whether all auth-related env vars landed correctly, and
 * prints a compact PASS/FAIL report. NEVER prints the secret value
 * itself (presence + length only). Touches no DB, sends no email.
 */

import { ensureNacosConfig } from '../src/lib/nacos-config';

interface KeyExpectation {
  key: string;
  required: boolean;
  category: string;
  /** Custom validator on the string value (sets reason if non-empty). */
  validate?: (v: string) => string | undefined;
}

const HEX = (n: number) => new RegExp(`^[A-Za-z0-9+/=_-]{${n},}$`);

function makeExpectations(env: 'dev' | 'test' | 'prod'): KeyExpectation[] {
  const isProd = env === 'prod';
  const isDev = env === 'dev';
  return [
    // ── auth core ──
    {
      key: 'JWT_SECRET',
      required: true,
      category: 'auth',
      validate: (v) => (HEX(32).test(v) ? undefined : 'too short or unexpected charset'),
    },
    {
      key: 'AUTH_SECRET',
      required: true,
      category: 'auth',
      validate: (v) => (HEX(32).test(v) ? undefined : 'too short'),
    },
    {
      key: 'AUTH_URL',
      required: true,
      category: 'auth',
      validate: (v) => (/^https?:\/\//.test(v) ? undefined : 'must be http(s)://...'),
    },
    {
      key: 'AUTH_EMAIL_CODE_RETURN_IN_RESPONSE',
      required: !isDev,
      category: 'auth',
      validate: (v) => {
        if (isProd && v.toLowerCase() !== 'false')
          return '🚨 MUST be "false" in prod (otherwise verification codes leak in API responses)';
        if (isDev && v.toLowerCase() !== 'true') return 'expected "true" for dev convenience';
        if (env === 'test' && v.toLowerCase() !== 'false') return 'expected "false"';
        return undefined;
      },
    },

    // ── email (smtp) ──
    { key: 'SMTP_HOST', required: !isDev, category: 'smtp' },
    {
      key: 'SMTP_PORT',
      required: !isDev,
      category: 'smtp',
      validate: (v) => (/^\d+$/.test(v) ? undefined : 'must be a port number'),
    },
    {
      key: 'SMTP_SECURE',
      required: !isDev,
      category: 'smtp',
      validate: (v) => (['true', 'false'].includes(v.toLowerCase()) ? undefined : 'must be true/false'),
    },
    { key: 'SMTP_USER', required: !isDev, category: 'smtp' },
    { key: 'SMTP_PASS', required: !isDev, category: 'smtp' },
    {
      key: 'SMTP_FROM',
      required: !isDev,
      category: 'smtp',
      validate: (v) => (v.includes('@') ? undefined : 'must be an email or "Name <email>"'),
    },

    // ── DB ──
    { key: 'DATABASE_URL', required: false, category: 'db' },
    { key: 'REMOTE_MYSQL_HOST', required: true, category: 'db' },
    { key: 'REMOTE_MYSQL_PORT', required: true, category: 'db' },
    { key: 'REMOTE_MYSQL_USER', required: true, category: 'db' },
    { key: 'REMOTE_MYSQL_PASSWORD', required: true, category: 'db' },
    { key: 'REMOTE_MYSQL_DATABASE', required: true, category: 'db' },

    // ── redis (used by token blacklist + code cache) ──
    { key: 'REDIS_URL', required: false, category: 'redis' },
    { key: 'REDIS_HOST', required: false, category: 'redis' },
    { key: 'REDIS_PORT', required: false, category: 'redis' },

    // ── optional providers ──
    // Nacos convention: NEXT_PUBLIC_* prefix for client-visible IDs;
    // _SECRET stays server-only (no prefix).
    { key: 'NEXT_PUBLIC_GOOGLE_CLIENT_ID', required: false, category: 'oauth' },
    { key: 'GOOGLE_CLIENT_SECRET', required: false, category: 'oauth' },
    { key: 'NEXT_PUBLIC_GITHUB_CLIENT_ID', required: false, category: 'oauth' },
    { key: 'GITHUB_CLIENT_SECRET', required: false, category: 'oauth' },
    { key: 'CHUANGLAN_API_USER', required: false, category: 'sms' },
    { key: 'CHUANGLAN_API_KEY', required: false, category: 'sms' },
    { key: 'CHUANGLAN_TEMPLATE_ID', required: false, category: 'sms' },
    { key: 'RESEND_API_KEY', required: false, category: 'email-alt' },
    { key: 'RESEND_FROM_EMAIL', required: false, category: 'email-alt' },
  ];
}

function red(s: string) {
  return `\x1b[31m${s}\x1b[0m`;
}
function green(s: string) {
  return `\x1b[32m${s}\x1b[0m`;
}
function yellow(s: string) {
  return `\x1b[33m${s}\x1b[0m`;
}
function gray(s: string) {
  return `\x1b[90m${s}\x1b[0m`;
}
function bold(s: string) {
  return `\x1b[1m${s}\x1b[0m`;
}

async function main() {
  const env = (process.env.APP_ENV || 'dev') as 'dev' | 'test' | 'prod';
  if (!['dev', 'test', 'prod'].includes(env)) {
    console.error(`Unsupported APP_ENV: ${env}`);
    process.exit(2);
  }

  console.log(bold(`\n━━━ Nacos auth-config verification — APP_ENV=${env} ━━━\n`));

  await ensureNacosConfig();

  const expectations = makeExpectations(env);
  const grouped: Record<string, KeyExpectation[]> = {};
  for (const e of expectations) {
    if (!grouped[e.category]) grouped[e.category] = [];
    grouped[e.category].push(e);
  }

  let fail = 0;
  let warn = 0;
  for (const cat of Object.keys(grouped)) {
    console.log(bold(`【${cat}】`));
    for (const exp of grouped[cat]) {
      const v = process.env[exp.key];
      const present = v !== undefined && v !== '';
      let status = '';
      let detail = '';
      if (present) {
        const len = v!.length;
        const reason = exp.validate?.(v!);
        if (reason) {
          status = red('✗ FAIL');
          detail = `${reason}`;
          fail++;
        } else {
          status = green('✓ OK  ');
          detail = `len=${len}`;
        }
      } else {
        if (exp.required) {
          status = red('✗ MISSING');
          detail = 'REQUIRED but unset';
          fail++;
        } else {
          status = gray('○ -    ');
          detail = '(optional, unset)';
        }
      }
      console.log(`  ${status}  ${exp.key.padEnd(38)} ${detail}`);
    }
    console.log();
  }

  // ── cross-cutting checks ──
  const xs: { name: string; check: () => string | undefined }[] = [
    {
      name: 'JWT_SECRET ≠ AUTH_SECRET',
      check: () =>
        process.env.JWT_SECRET && process.env.JWT_SECRET === process.env.AUTH_SECRET
          ? '🚨 JWT_SECRET and AUTH_SECRET must differ (different threat models)'
          : undefined,
    },
    {
      name: 'AUTH_URL matches env',
      check: () => {
        const u = process.env.AUTH_URL || '';
        if (env === 'prod' && !u.includes('prismer.cloud')) return `expected prod AUTH_URL on prismer.cloud, got ${u}`;
        if (env === 'test' && !u.includes('cloud.prismer.dev'))
          return `expected test AUTH_URL on cloud.prismer.dev, got ${u}`;
        if (env === 'dev' && !u.startsWith('http://localhost')) return `expected dev AUTH_URL on localhost, got ${u}`;
        return undefined;
      },
    },
    {
      name: 'Email provider configured (test/prod only)',
      check: () => {
        if (env === 'dev') return undefined;
        const hasResend = !!process.env.RESEND_API_KEY;
        const hasSmtp = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
        if (!hasResend && !hasSmtp) return 'NEITHER Resend nor SMTP configured — verification emails will fail in prod';
        return undefined;
      },
    },
    {
      name: 'SMTP port + secure flag consistency',
      check: () => {
        const port = process.env.SMTP_PORT;
        const secure = (process.env.SMTP_SECURE || '').toLowerCase();
        if (!port) return undefined;
        if (port === '465' && secure !== 'true') return 'port 465 requires SMTP_SECURE=true (implicit TLS)';
        if (port === '587' && secure === 'true') return 'port 587 typically uses STARTTLS (SMTP_SECURE=false)';
        return undefined;
      },
    },
  ];

  console.log(bold('【cross-cutting】'));
  for (const x of xs) {
    const reason = x.check();
    if (reason) {
      console.log(`  ${yellow('⚠ WARN')}  ${x.name.padEnd(38)} ${reason}`);
      warn++;
    } else {
      console.log(`  ${green('✓ OK  ')}  ${x.name}`);
    }
  }
  console.log();

  // ── summary ──
  if (fail > 0) {
    console.log(red(bold(`✗ ${fail} FAIL(s), ${warn} WARN(s)`)));
    process.exit(1);
  }
  if (warn > 0) {
    console.log(yellow(bold(`⚠ ${warn} WARN(s) — review above`)));
    process.exit(0);
  }
  console.log(green(bold('✓ All auth config checks passed')));
}

main().catch((err) => {
  console.error(red('Verifier crashed:'), err);
  process.exit(2);
});
