import { describe, expect, it } from 'vitest';
import { normalizeApiKeyLabel } from '@/lib/db-api-keys';

describe('normalizeApiKeyLabel', () => {
  it('keeps normal API key labels unchanged', () => {
    expect(normalizeApiKeyLabel('New Key')).toBe('New Key');
  });

  it('turns legacy workspace-runtime JSON labels into display labels', () => {
    expect(
      normalizeApiKeyLabel(
        'workspace-runtime {"kind":"workspace-runtime","workspaceId":"ws1","runtimeInstanceId":"rt-abc","daemonId":"container:rt-abc","name":null}',
      ),
    ).toBe('Workspace Runtime: rt-abc');
  });

  it('uses the runtime name when present', () => {
    expect(
      normalizeApiKeyLabel(
        'workspace-runtime {"kind":"workspace-runtime","workspaceId":"ws1","runtimeInstanceId":"rt-abc","daemonId":"container:rt-abc","name":"Build worker"}',
      ),
    ).toBe('Workspace Runtime: Build worker');
  });
});
