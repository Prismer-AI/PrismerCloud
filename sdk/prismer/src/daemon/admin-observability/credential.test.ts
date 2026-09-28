import { describe, expect, it } from 'vitest';
import { CloudClient } from '../../auth.js';
import { takeAdminObservabilityCloud } from './credential.js';

describe('daemon-held Admin observability credential', () => {
  it('captures a dedicated key, never reuses the general gateway key, and erases the env copy', () => {
    const env: Record<string, string | undefined> = {
      APP_ENV: 'prod',
      PRISMER_ADMIN_API_KEY: 'admin-only-key',
    };
    const general = new CloudClient({ baseUrl: 'https://cloud.invalid', apiKey: 'agent-visible-gateway-key' });
    const admin = takeAdminObservabilityCloud({ env, baseUrl: 'https://cloud.invalid', generalCloud: general });
    expect(admin).not.toBe(general);
    expect(admin?.apiKey).toBe('admin-only-key');
    expect('PRISMER_ADMIN_API_KEY' in env).toBe(false);
  });

  it('fails closed in production even when owner fallback is requested', () => {
    const general = new CloudClient({ baseUrl: 'https://cloud.invalid', apiKey: 'general-key' });
    expect(takeAdminObservabilityCloud({
      env: { APP_ENV: 'prod', ADMIN_API_KEY_ALLOW_OWNER_FALLBACK: 'true' },
      baseUrl: 'https://cloud.invalid',
      generalCloud: general,
    })).toBeUndefined();
  });

  it('permits explicit owner fallback only outside production', () => {
    const general = new CloudClient({ baseUrl: 'https://cloud.invalid', apiKey: 'general-key' });
    expect(takeAdminObservabilityCloud({
      env: { APP_ENV: 'dev', ADMIN_API_KEY_ALLOW_OWNER_FALLBACK: 'true' },
      baseUrl: 'https://cloud.invalid',
      generalCloud: general,
    })).toBe(general);
  });
});
