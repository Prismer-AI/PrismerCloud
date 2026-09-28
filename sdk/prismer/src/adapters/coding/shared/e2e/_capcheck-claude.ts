/**
 * _capcheck-claude.ts — 临时活证 probe（非 vitest，绕开 120s 硬预算）。
 *
 * 目标：在本地网关上真跑 claude-code，用**硬副作用**证明桌面 runtime host 能：
 *   (1) 对本地 FS 做 CRUD  → 断言 crud.txt 落盘且内容匹配
 *   (2) 执行 shell 命令     → recorder 里出现 input=ls 的 shell 工具调用
 *   (3) 跑 python           → 让 python 写 pyout.txt，断言其内容 = PYOK_42（python 真执行的产物）
 *
 * 不断言聊天文本。大预算（默认 15min），本地 kimi 慢是已知的。
 * 跑法：npx tsx src/adapters/coding/shared/e2e/_capcheck-claude.ts
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { binaryAvailable, makeService, makeTaskInput, tmpCwd, rmCwd } from './harness';

const BUDGET_MS = Number(process.env.CAPCHECK_BUDGET_MS ?? 900_000);

async function main() {
  const ok = await binaryAvailable('claude');
  if (!ok) {
    console.log('[capcheck] SKIP — claude binary not on PATH');
    process.exit(2);
  }
  const cwd = tmpCwd('capcheck-claude-');
  console.log(`[capcheck] cwd=${cwd}`);
  const service = await makeService('claude', cwd, {
    modeId: 'bypassPermissions',
    model: process.env.CAPCHECK_MODEL ?? 'deepseek-v4-flash',
    proxyProvider: process.env.CAPCHECK_PROXY ?? 'deepseek',
  });
  const { task, recorder } = makeTaskInput({
    prompt: [
      'Perform EXACTLY these steps using your tools, one by one, then reply DONE:',
      '1. Use the Write tool to create a file named crud.txt in the current directory whose content is exactly: HELLO_CRUD',
      '2. Use the Bash tool to run exactly this command: ls',
      "3. Use the Bash tool to run exactly this command: python3 -c \"open('pyout.txt','w').write('PYOK_%d' % (6*7))\"",
      'Then reply with exactly: DONE',
    ].join('\n'),
  });

  const started = Date.now();
  const timer = setTimeout(() => {
    console.error(`[capcheck] ❌ wall-clock budget ${BUDGET_MS}ms exceeded — aborting`);
    task.signal && (task as any).controller?.abort?.();
    process.exit(3);
  }, BUDGET_MS);
  timer.unref?.();

  let result: any;
  try {
    result = await service.dispatch(task);
  } catch (err) {
    console.error(`[capcheck] ❌ dispatch threw: ${(err as Error).message}`);
    await service.shutdown().catch(() => {});
    process.exit(1);
  }
  clearTimeout(timer);
  console.log(`[capcheck] dispatch done in ${Math.round((Date.now() - started) / 1000)}s ok=${result?.ok}`);

  // ---- side-effect oracles ----
  const crudPath = path.join(cwd, 'crud.txt');
  const pyPath = path.join(cwd, 'pyout.txt');
  const shellCalls = recorder.toolCalls.filter((c: any) => {
    const n = String(c.toolName).toLowerCase();
    return n === 'bash' || n === 'shell' || n.includes('bash');
  });
  const lsCall = shellCalls.find((c: any) => JSON.stringify(c.input ?? '').includes('ls'));

  const crudOk = existsSync(crudPath) && readFileSync(crudPath, 'utf8').includes('HELLO_CRUD');
  const pyOk = existsSync(pyPath) && readFileSync(pyPath, 'utf8').includes('PYOK_42');
  const lsOk = !!lsCall;

  console.log('[capcheck] ── results ──');
  console.log(`[capcheck]  FS CRUD (crud.txt=HELLO_CRUD)      : ${crudOk ? 'PASS' : 'FAIL'}`);
  console.log(`[capcheck]  shell exec (ls tool call captured) : ${lsOk ? 'PASS' : 'FAIL'}`);
  console.log(`[capcheck]  python exec (pyout.txt=PYOK_42)    : ${pyOk ? 'PASS' : 'FAIL'}`);
  console.log(`[capcheck]  toolCalls=${recorder.toolCalls.map((c: any) => c.toolName).join(',')}`);

  await service.shutdown().catch(() => {});
  rmCwd(cwd);
  const allPass = crudOk && lsOk && pyOk;
  console.log(`[capcheck] ${allPass ? '✅ ALL PASS' : '❌ SOME FAILED'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error('[capcheck] fatal', e);
  process.exit(1);
});
