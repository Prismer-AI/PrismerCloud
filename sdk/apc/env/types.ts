/**
 * types.ts — env 脚手架的共享类型（apc/06 §1-§3）。
 *
 * 三态纪律（06 §3 / 02 §2 R1）：
 *   pass — 判定跑过且合格
 *   fail — 判定跑过且不合格 → 环境故障域（`env_blocked`），**不是 SUT 红**
 *   skip — **判定没跑成**（探针本身不可用 / 前置缺失）。
 *          「没检测」≠「没问题」——照 test204 `lib/manifest.ts` 文件头的死穴纪律，
 *          skip 绝不允许被读成 pass；`scripts/test203/run.ts::parseExternalDoctor`
 *          会把 skip 项直接丢掉，于是消费者判成「doctor 未覆盖该检查项」→ env_blocked。
 *          那正是我们要的语义。
 */

export type EnvSection = 'infra' | 'toolchain' | 'secrets' | 'project';

export type ItemStatus = 'pass' | 'fail' | 'skip';

/**
 * 判定强度的**诚实标注**（apc/11 §1 铁律 4：判定强度不许私自削薄；做不到就标出来）。
 *
 *   protocol   — 协议级握手（MySQL handshake+query / RESP PING / HTTP 200 / k8s API）
 *   consistency— 两个真实来源逐项比对（lockfile ⇄ node_modules、/VERSION ⇄ 各版本文件）
 *   version    — 取真实 `--version` 并与 manifest pin **比对**
 *   presence   — 只判在场（凭据类：不读值、不打印，只报缺）
 *   process    — 进程/端口态（listener、docker daemon）
 */
export type Strength = 'protocol' | 'consistency' | 'version' | 'presence' | 'process';

export interface ItemResult {
  status: ItemStatus;
  /** 人可读证据。**绝不含密钥值**（凭据项只报键名在/不在）。 */
  detail: string;
}

export interface EnvItem {
  /**
   * 稳定 id。**承重约束**：`scripts/test203/run.ts` 的 `TIER_ENV_REQUIRES`（run.ts:234）
   * 按**子串**匹配 tier 的环境依赖 —— T3 需 `cloud`；T4 需 `mysql`/`redis`/`cloud`。
   * 改 id 前先看 `__tests__/run-ts-contract.test.ts`（它对真 `parseExternalDoctor` 验）。
   */
  id: string;
  section: EnvSection;
  label: string;
  /** 判定强度（诚实标注，进 doctor JSON）。 */
  strength: Strength;
  /** 红了怎么修。`apc env up` 不代办的项（凭据/签名 key）只出这个。 */
  fixHint: string;
  /** true = `apc env up` **明确不代办**（06 §0 原则 2：凭据类给 fix-hint 不代办）。 */
  manualOnly?: boolean;
  check(): Promise<ItemResult>;
}

export interface DoctorItem {
  item: string;
  label: string;
  section: EnvSection;
  status: ItemStatus;
  strength: Strength;
  detail: string;
  fixHint: string;
  durationMs: number;
}

export type EnvStatus = 'ok' | 'env_blocked';

export interface DoctorReport {
  /**
   * 第三态 token（06 §3 / 02 §2 R1）。`env_blocked` = 环境故障域，
   * **不计 SUT 红、不进回归判据、不触发 H2 redispatch**。
   */
  envStatus: EnvStatus;
  /** 0 = 全绿；78 = env_blocked（沿 `scripts/test203/run.ts` 的 `ENV_BLOCKED_EXIT`）。 */
  exitCode: number;
  generatedAt: string;
  summary: { pass: number; fail: number; skip: number; total: number };
  /** 红项 id（fix-hint 在 items 里）。 */
  failed: string[];
  /** 没跑成的判定 id —— 「未检测」，不是「没问题」。 */
  undetected: string[];
  items: DoctorItem[];
}

/** doctor 红 → 该退出码。与 `scripts/test203/run.ts:79 ENV_BLOCKED_EXIT` 同值。 */
export const ENV_BLOCKED_EXIT = 78;
