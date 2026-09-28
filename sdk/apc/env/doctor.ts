#!/usr/bin/env npx tsx
/**
 * doctor.ts — `apc env doctor`（apc/06 §2）。**只读**判定，任何机器上安全跑。
 *
 * ## 三条硬约束
 *
 * 1. **stdout 必须是纯 JSON**。`scripts/test203/run.ts:175` 已经在消费本文件：
 *    `spawnSync('npx', ['tsx', 'sdk/apc/env/doctor.ts'])` → `parseExternalDoctor(stdout)`。
 *    解析不出东西它会**静默回退**内置 StageG 4 项检查，而这边看起来"还是绿的"——
 *    正是本专项要杜绝的假验证形态。所以：进度/摘要一律走 stderr。
 *    canonical 形状 = `{ items: [{ item, label, status: 'pass'|'fail' }] }`。
 *
 * 2. **逐项 try/catch**：一项探针崩了不塌全轮；崩了的那项记 `fail` 并把异常原文带进
 *    detail（探针自己坏 = 判定没跑成，绝不许当 pass）。
 *
 * 3. **`env_blocked` 在这一层物化**（治 doc 13 的 E3：上一轮只返 0/1，把第三态推给了
 *    当时还不存在的消费者）。本文件产出 `envStatus` token + exit code 78
 *    （== `scripts/test203/run.ts:79 ENV_BLOCKED_EXIT`）。
 */
import { ENV_MANIFEST } from './manifest';
import { writeStdout } from './probes';
import { ENV_BLOCKED_EXIT } from './types';
import type { DoctorItem, DoctorReport, EnvItem } from './types';

const PROBE_TIMEOUT_MS = 180_000;

function timeout(ms: number, id: string): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`[doctor] 探针 ${id} 超时 ${ms}ms —— 判定未完成，记 fail（不是 pass）`)), ms).unref?.(),
  );
}

/** 跑一项。**任何异常都收敛成 fail**（判定没跑完 ≠ 环境没问题）。 */
export async function runItem(item: EnvItem, timeoutMs = PROBE_TIMEOUT_MS): Promise<DoctorItem> {
  const t0 = Date.now();
  const base = {
    item: item.id,
    label: item.label,
    section: item.section,
    strength: item.strength,
    fixHint: item.fixHint,
  };
  try {
    const r = await Promise.race([item.check(), timeout(timeoutMs, item.id)]);
    return { ...base, status: r.status, detail: r.detail, durationMs: Date.now() - t0 };
  } catch (e) {
    return {
      ...base,
      status: 'fail',
      detail: `探针异常（判定未完成）：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
      durationMs: Date.now() - t0,
    };
  }
}

export interface DoctorOptions {
  items?: EnvItem[];
  timeoutMs?: number;
}

export async function doctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const manifest = opts.items ?? ENV_MANIFEST;
  const items: DoctorItem[] = [];
  for (const it of manifest) items.push(await runItem(it, opts.timeoutMs));

  const failed = items.filter((i) => i.status === 'fail').map((i) => i.item);
  const undetected = items.filter((i) => i.status === 'skip').map((i) => i.item);
  const envStatus = failed.length ? 'env_blocked' : 'ok';
  return {
    envStatus,
    exitCode: failed.length ? ENV_BLOCKED_EXIT : 0,
    generatedAt: new Date().toISOString(),
    summary: {
      pass: items.filter((i) => i.status === 'pass').length,
      fail: failed.length,
      skip: undetected.length,
      total: items.length,
    },
    failed,
    undetected,
    items,
  };
}

/** 人可读摘要 —— **只往 stderr 写**（stdout 是消费者的 JSON 通道）。 */
export function renderHuman(report: DoctorReport): string {
  const glyph: Record<DoctorItem['status'], string> = { pass: '✔', fail: '✘', skip: '?' };
  const lines: string[] = [];
  lines.push(`[apc env doctor] ${report.envStatus}  pass=${report.summary.pass} fail=${report.summary.fail} skip=${report.summary.skip}`);
  let section = '';
  for (const i of report.items) {
    if (i.section !== section) {
      section = i.section;
      lines.push(`  — ${section} —`);
    }
    lines.push(`  ${glyph[i.status]} ${i.item} [${i.strength}] ${i.detail}`);
    if (i.status === 'fail') lines.push(`      fix: ${i.fixHint}`);
    if (i.status === 'skip') lines.push(`      ⚠ 未检测 ≠ 无问题 · fix: ${i.fixHint}`);
  }
  if (report.envStatus === 'env_blocked')
    lines.push(
      `  ⛔ env_blocked（exit ${ENV_BLOCKED_EXIT}）—— 环境故障域，不计 SUT 红、不进回归判据、不触发 redispatch；先跑 \`apc env up\``,
    );
  return lines.join('\n');
}

export async function main(): Promise<number> {
  const report = await doctor();
  await writeStdout(JSON.stringify(report, null, 2) + '\n');
  process.stderr.write(renderHuman(report) + '\n');
  return report.exitCode;
}

// 直接被 `npx tsx sdk/apc/env/doctor.ts` 跑起来时才执行（被 import 时不跑）。
if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      // 连 doctor 本身都崩了：stdout 仍给出**可解析**的 env_blocked 报告，
      // 否则消费者会静默回退到内置检查并把这次跑判成"环境没问题"。
      const fallback: DoctorReport = {
        envStatus: 'env_blocked',
        exitCode: ENV_BLOCKED_EXIT,
        generatedAt: new Date().toISOString(),
        summary: { pass: 0, fail: 1, skip: 0, total: 1 },
        failed: ['doctor.self'],
        undetected: [],
        items: [
          {
            item: 'doctor.self',
            label: 'apc env doctor 自身',
            section: 'project',
            status: 'fail',
            strength: 'process',
            detail: `doctor 崩溃：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
            fixHint: 'npx tsx sdk/apc/env/doctor.ts 看堆栈',
            durationMs: 0,
          },
        ],
      };
      process.stdout.write(JSON.stringify(fallback, null, 2) + '\n');
      process.exit(ENV_BLOCKED_EXIT);
    },
  );
}
