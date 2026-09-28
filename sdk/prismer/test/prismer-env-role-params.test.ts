// product204/37 WS-3 — role parameters over the wire (metadata.roleParams /
// metadata.roleParamsEnv). Secret / user-kind params ride ENV-ONLY; non-secret
// behaviour params ride STRUCTURED and render into the agent prompt. This pins
// the daemon-side split + env merge without spawning an adapter.

import { describe, it, expect } from 'vitest';
import {
  applyPrismerScopeEnv,
  isHighRiskCredentialEnvKey,
  renderRoleParamsBlock,
  roleParamsEnvFromMetadata,
  roleParamsFromMetadata,
} from '../src/adapters/prismer-env';

describe('prismer-env role params (product204/37 WS-3)', () => {
  it('roleParamsFromMetadata reads behaviour knobs; ignores non-string/oversized', () => {
    const out = roleParamsFromMetadata({
      roleParams: { speakingStyle: '正常', tone: 'warm', bad: 123, empty: '' },
    });
    expect(out).toEqual({ speakingStyle: '正常', tone: 'warm' });
  });

  it('roleParamsEnvFromMetadata keeps only UPPER_SNAKE, PRISMER_-free, non-empty', () => {
    const out = roleParamsEnvFromMetadata({
      roleParamsEnv: { API_KEY: 'sk-secret', PRISMER_HACK: 'x', lower: 'y', OK_2: 'z', EMPTY: '' },
    });
    expect(out).toEqual({ API_KEY: 'sk-secret', OK_2: 'z' });
  });

  it('renderRoleParamsBlock renders a deterministic (sorted) block; empty → ""', () => {
    expect(renderRoleParamsBlock({})).toBe('');
    const block = renderRoleParamsBlock({ tone: 'warm', speakingStyle: '骚' });
    expect(block).toContain('## Role parameters');
    // ascending key order
    expect(block.indexOf('speakingStyle')).toBeLessThan(block.indexOf('tone'));
    expect(block).toContain('- speakingStyle: 骚');
  });

  it('applyPrismerScopeEnv merges roleParamsEnv into child env (after skillConfigEnv)', () => {
    const env: Record<string, string | undefined> = {};
    applyPrismerScopeEnv(env, {
      skillConfigEnv: { SKILL_KEY: 'sk-1' },
      roleParamsEnv: { ROLE_SECRET: 'sk-2' },
    });
    expect(env.SKILL_KEY).toBe('sk-1');
    expect(env.ROLE_SECRET).toBe('sk-2');
  });

  it('NEGATIVE control: behaviour roleParams NEVER leak into env (env-only is roleParamsEnv)', () => {
    const env: Record<string, string | undefined> = {};
    applyPrismerScopeEnv(env, { roleParams: { speakingStyle: '正常' } });
    // speakingStyle is behaviour → prompt-only; it must not appear as an env var.
    expect(env.speakingStyle).toBeUndefined();
    expect(Object.keys(env)).not.toContain('speakingStyle');
  });

  it('M3-5c negative control: daemon credentials are scrubbed, dev vars remain', () => {
    const env: Record<string, string | undefined> = {
      NODE_ENV: 'development',
      DEBUG: '1',
      NACOS_PASSWORD: 'nacos-secret',
      RDS_PASSWORD: 'rds-secret',
      ADMIN_API_KEY: 'admin-secret',
      PRISMER_ADMIN_API_KEY: 'daemon-admin-secret',
      OTA_SIGNING_KEY: 'ota-secret',
    };
    applyPrismerScopeEnv(env, {
      skillConfigEnv: {
        DEV_ENDPOINT: 'http://127.0.0.1:3000',
        NACOS_SECRET_KEY: 'metadata-secret',
      },
      roleParamsEnv: { RDS_TOKEN: 'metadata-token' },
    });
    expect(env.NODE_ENV).toBe('development');
    expect(env.DEBUG).toBe('1');
    for (const key of ['NACOS_PASSWORD', 'RDS_PASSWORD', 'ADMIN_API_KEY', 'PRISMER_ADMIN_API_KEY', 'OTA_SIGNING_KEY', 'NACOS_SECRET_KEY', 'RDS_TOKEN']) {
      expect(env[key]).toBeUndefined();
    }
    expect(isHighRiskCredentialEnvKey('RDS_HOST')).toBe(false);
    expect(isHighRiskCredentialEnvKey('DEV_ENDPOINT')).toBe(false);
  });
});
