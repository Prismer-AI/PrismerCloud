/**
 * doctor.test.ts — doctor 编排层的验收：**第三态物化**（治 E3）+ 逐项 try/catch 隔离。
 *
 * 这里用**合成 EnvItem** 打编排层（不是打真环境——真环境判定在 manifest.test.ts）：
 * 编排层要证明的是"红怎么变成 env_blocked / 一项崩了会不会塌全轮"，那是纯逻辑，
 * 用真环境去打反而不可控。真环境 + 真子进程的端到端在 run-ts-contract.test.ts。
 */
import { describe, expect, it } from 'vitest';
import { doctor, renderHuman, runItem } from '../doctor';
import { ENV_BLOCKED_EXIT } from '../types';
import type { EnvItem, ItemResult } from '../types';

function item(id: string, result: ItemResult | (() => Promise<ItemResult>)): EnvItem {
  return {
    id,
    section: 'infra',
    label: `label:${id}`,
    strength: 'protocol',
    fixHint: `fix:${id}`,
    check: typeof result === 'function' ? result : async () => result,
  };
}

describe('env_blocked 在 env 层物化（治 doc 13 E3：上一轮只返 0/1）', () => {
  it('全绿 → envStatus=ok，exit 0', async () => {
    const r = await doctor({ items: [item('a', { status: 'pass', detail: 'ok' })] });
    expect(r.envStatus).toBe('ok');
    expect(r.exitCode).toBe(0);
    expect(r.failed).toEqual([]);
  });

  it('任一红 → envStatus=env_blocked，exit 78，失败项清单带 id', async () => {
    const r = await doctor({
      items: [item('a', { status: 'pass', detail: 'ok' }), item('infra.redis-6380', { status: 'fail', detail: 'down' })],
    });
    expect(r.envStatus).toBe('env_blocked');
    expect(r.exitCode).toBe(ENV_BLOCKED_EXIT);
    expect(r.failed).toEqual(['infra.redis-6380']);
    // fix-hint 必须在 items 里可取（消费者要能把它 surface 给人）
    expect(r.items.find((i) => i.item === 'infra.redis-6380')!.fixHint).toBe('fix:infra.redis-6380');
  });

  it('skip 不算红：进 undetected，不触发 env_blocked，但也绝不算 pass', async () => {
    const r = await doctor({ items: [item('a', { status: 'skip', detail: '未检测' })] });
    expect(r.envStatus).toBe('ok');
    expect(r.exitCode).toBe(0);
    expect(r.undetected).toEqual(['a']);
    expect(r.summary.pass).toBe(0);
    expect(r.summary.skip).toBe(1);
  });

  it('负控：把"任一红即 env_blocked"的判据挪成"全红才 blocked"会立刻被这条抓住', async () => {
    // 1 红 1 绿 —— 只有正确判据（any fail）才会给出 env_blocked。
    const r = await doctor({
      items: [item('ok1', { status: 'pass', detail: '' }), item('bad1', { status: 'fail', detail: '' })],
    });
    expect(r.envStatus).toBe('env_blocked');
    expect(r.summary).toEqual({ pass: 1, fail: 1, skip: 0, total: 2 });
  });
});

describe('逐项 try/catch —— 一项崩不塌全轮（06 §2 doctor 只读安全）', () => {
  it('探针抛异常 → 该项 fail 且带堆栈，其余项照常判定', async () => {
    const r = await doctor({
      items: [
        item('before', { status: 'pass', detail: 'ok' }),
        item('boom', async () => {
          throw new Error('probe exploded');
        }),
        item('after', { status: 'pass', detail: 'ok' }),
      ],
    });
    expect(r.items.map((i) => i.item)).toEqual(['before', 'boom', 'after']);
    expect(r.items.find((i) => i.item === 'boom')!.status).toBe('fail');
    expect(r.items.find((i) => i.item === 'boom')!.detail).toContain('probe exploded');
    expect(r.items.filter((i) => i.status === 'pass').map((i) => i.item)).toEqual(['before', 'after']);
  });

  it('探针挂住不返回 → 超时收敛成 fail（不是 pass、不是永远挂着）', async () => {
    const stuck = item('stuck', () => new Promise<ItemResult>(() => {}));
    const r = await runItem(stuck, 120);
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('超时');
  }, 10_000);

  it('负控：如果 catch 里写成 status:"pass"，这条会红 —— 崩溃绝不许算通过', async () => {
    const r = await runItem(
      item('boom2', async () => {
        throw new Error('x');
      }),
    );
    expect(r.status).not.toBe('pass');
    expect(r.status).not.toBe('skip');
  });
});

describe('人可读摘要只是 stderr 的装饰，不参与判定', () => {
  it('红项带 fix、skip 项带"未检测"警示', async () => {
    const r = await doctor({
      items: [item('bad', { status: 'fail', detail: 'd' }), item('unk', { status: 'skip', detail: 'u' })],
    });
    const text = renderHuman(r);
    expect(text).toContain('fix: fix:bad');
    expect(text).toContain('未检测 ≠ 无问题');
    expect(text).toContain(`exit ${ENV_BLOCKED_EXIT}`);
  });
});
