import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { OwnedExecutionEnv } from '../src/adapters/runtime-engine/pi-core/owned-execution-env.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, {recursive:true,force:true})));
it('does not claim cleanup after losing its process-group supervisor unexpectedly', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'owned-shell-')); roots.push(cwd);
  const env = new OwnedExecutionEnv({cwd});
  await env.exec('kill -KILL "$PPID"');
  await expect(env.cleanup()).rejects.toThrow('supervisor ownership lost');
});
it('preserves stdout, stderr and exit code and refuses new execution after cleanup', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'owned-shell-')); roots.push(cwd);
  const env = new OwnedExecutionEnv({cwd});
  try {
    expect(await env.exec('printf "$PROBE"; printf err >&2; exit 7', {env:{PROBE:'out'}}))
      .toEqual({ok:true,value:{stdout:'out',stderr:'err',exitCode:7}});
    await env.cleanup();
    expect(await env.exec('printf forbidden')).toMatchObject({ok:false,error:expect.objectContaining({message:'aborted'})});
  } finally { await env.cleanup(); }
});

it('decodes split UTF-8 chunks before forwarding tool output', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'owned-shell-')); roots.push(cwd);
  const env = new OwnedExecutionEnv({cwd});
  try {
    const result = await env.exec("printf '\\342'; sleep 0.02; printf '\\202\\254'");
    expect(result).toMatchObject({ok:true,value:{stdout:'€'}});
  } finally { await env.cleanup(); }
});
