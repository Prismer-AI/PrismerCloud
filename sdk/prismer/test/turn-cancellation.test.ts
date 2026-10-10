import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { OwnedExecutionEnv as NodeExecutionEnv } from '../src/adapters/runtime-engine/pi-core/owned-execution-env.js';
import { afterEach, expect, it } from 'vitest';
import { runTurnFile, runTurnOnce, type TurnSessionHandle } from '../src/turn/runner.js';
import { TURN_PROTOCOL_VERSION, type TurnEnvelopeV1, type TurnEgressV1 } from '../src/turn/protocol.js';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'eaas-cancel-'));
  directories.push(dir);
  const envelope: TurnEnvelopeV1 = {
    protocolVersion: TURN_PROTOCOL_VERSION, turnId: 'cancel-test', message: { text: 'run shell' },
    history: [], systemPrompt: 'test', workdir: dir, deadlineMs: 10_000, cancelFile: join(dir, 'cancel'),
  };
  const egress: TurnEgressV1 = {
    protocolVersion: TURN_PROTOCOL_VERSION, url: 'http://127.0.0.1:1/v1', token: 'test',
    model: 'test', provider: 'cloud-egress',
  };
  return { dir, envelope, egress };
}
async function waitForFile(path: string) {
  const deadline = Date.now() + 5000;
  while (!existsSync(path) && Date.now() < deadline) await delay(10);
  expect(existsSync(path)).toBe(true);
}

it('cancellation stops a real detached shell process tree without stopping an independent turn', async () => {
  const { dir, envelope, egress } = fixture();
  const execution = new NodeExecutionEnv({ cwd: dir });
  const sibling = new NodeExecutionEnv({ cwd: dir });
  const abort = new AbortController();
  // Same detached execution environment used by Pi tools. Ignore TERM to require its owned-group cleanup.
  const session: TurnSessionHandle = {
    subscribe: () => () => {},
    async run() {
      await execution.exec('trap "" TERM; printf ready > started; sleep 1.5; printf late > leaked', { abortSignal: abort.signal });
      return { finalText: 'shell finished' };
    },
    async interrupt() { abort.abort(); },
    async close() { await execution.cleanup(); },
  };
  const other = sibling.exec('sleep 1.8; printf healthy > sibling');
  const result = runTurnOnce(envelope, egress, { createSession: async () => session });
  try {
    await waitForFile(join(dir, 'started'));
    writeFileSync(envelope.cancelFile, '');
    const canceled = await result;
    await other;
    expect(existsSync(join(dir, 'sibling'))).toBe(true);
    expect(existsSync(join(dir, 'leaked'))).toBe(false);
    expect(canceled.status).toBe('canceled');
  } finally {
    await execution.cleanup();
    await sibling.cleanup();
    await result;
  }
}, 10_000);

it('a preexisting cancel sentinel prevents session creation and tool side effects', async () => {
  const { dir, envelope, egress } = fixture();
  writeFileSync(envelope.cancelFile, '');
  const result = await runTurnOnce(envelope, egress, {
    createSession: async () => {
      writeFileSync(join(dir, 'initialized'), 'unexpected');
      return { subscribe: () => () => {}, run: async () => ({ finalText: 'unexpected' }), interrupt: async () => {}, close: async () => {} };
    },
  });
  expect(existsSync(join(dir, 'initialized'))).toBe(false);
  expect(result.status).toBe('canceled');
});

it('CLI SIGTERM closes detached shell tools before writing the canceled result', async () => {
  const { dir, envelope, egress } = fixture();
  writeFileSync(join(dir, 'input.json'), JSON.stringify(envelope));
  writeFileSync(join(dir, 'egress.json'), JSON.stringify(egress));
  const program = `
    import { runTurnFile } from ${JSON.stringify(new URL('../src/turn/runner.ts', import.meta.url).href)};
    import { OwnedExecutionEnv as NodeExecutionEnv } from ${JSON.stringify(new URL('../src/adapters/runtime-engine/pi-core/owned-execution-env.ts', import.meta.url).href)};
    const dir = ${JSON.stringify(dir)};
    const execution = new NodeExecutionEnv({cwd:dir});
    const abort = new AbortController();
    const code = await runTurnFile({inputPath:dir+'/input.json',outputPath:dir+'/output.json',egressFilePath:dir+'/egress.json',deps:{createSession:async()=>({
      subscribe:()=>()=>{},
      run:async()=>{await execution.exec('trap "" TERM; printf ready > started; sleep 1.5; printf late > leaked',{abortSignal:abort.signal});return {finalText:'done'};},
      interrupt:async()=>{abort.abort();},close:async()=>{await execution.cleanup();}
    })}});
    process.exitCode = code;
  `;
  const child = spawn(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx'), '--input-type=module', '-e', program], { stdio: 'pipe' });
  let diagnostic = '';
  child.stderr.on('data', (chunk) => { diagnostic += String(chunk); });
  const exit = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    await waitForFile(join(dir, 'started'));
    child.kill('SIGTERM');
    const stopped = await exit;
    await delay(1800);
    expect(existsSync(join(dir, 'leaked')), diagnostic).toBe(false);
    expect(stopped).toEqual({ code: 0, signal: null });
    expect(JSON.parse(readFileSync(join(dir, 'output.json'), 'utf8')).status).toBe('canceled');
    expect(existsSync(join(dir, 'egress.json'))).toBe(false);
  } finally {
    child.kill('SIGKILL');
    await exit;
  }
}, 10_000);

it('cleanup failure never writes a canceled acknowledgement', async () => {
  const { dir, envelope, egress } = fixture();
  const abort = new AbortController();
  writeFileSync(join(dir, 'input.json'), JSON.stringify(envelope));
  writeFileSync(join(dir, 'egress.json'), JSON.stringify(egress));
  const code = await runTurnFile({ inputPath: join(dir, 'input.json'), outputPath: join(dir, 'output.json'),
    egressFilePath: join(dir, 'egress.json'), deps: { signal: abort.signal, createSession: async () => ({
      subscribe: () => () => {}, run: async () => { abort.abort(); return new Promise(() => {}); },
      interrupt: async () => {}, close: async () => { throw new Error('owned cleanup failed'); },
    }) } });
  expect(code).toBe(70);
  expect(existsSync(join(dir, 'output.json'))).toBe(false);
  expect(existsSync(join(dir, 'egress.json'))).toBe(false);
});
