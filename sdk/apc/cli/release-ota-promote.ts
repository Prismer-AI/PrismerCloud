/**
 * release-ota-promote.ts — `apc release ota-promote`（apc/01 §2 ota-promote，收口步 7/8/11）。
 *
 * ## 治 doc01 #8（线 3 = drain_respawn，不是 kill1）
 * 旧实现把 K8s 通道 shell out 到 `scripts/ops/runtime-ota.ts`——那是**线 1（`kill 1` 原地重启，
 * 仅 dev/紧急）**，会**打断在飞 task**。但本 verb 是**线 3 admin fleet 下发**，必须走 **drain_respawn**
 * （排空在飞 → 优雅 exit(0) → supervisor respawn → boot-OTA 换版，用户无感/无中断）。
 *
 * ## 正规 drain_respawn 路径（现已落地，B1 不再是 M5）
 * 线 3 的真机制 = admin rollout endpoint `POST /api/admin/runtime-releases/rollout`
 * （`src/im/api/admin.ts`）：它给每个目标 daemon 写 `runtime:update:apply:<daemonId>` + 下发
 * `runtime.update.apply` 帧（`src/im/ws/events.ts`），daemon 收到后 **arm drain_respawn**
 * （`sdk/prismer-cloud/runtime/src/daemon/runner.ts` applyRuntimeUpdate）。本 verb 因此**不再 spawn
 * kill1 的 runtime-ota.ts**，而是**构造这条 drain_respawn rollout 请求**。
 *
 * ## 本机替身边界（apc/04 §4.5 · release-common.ts §本机替身边界）
 * 「真 fleet rollout」是远端写入，一律**止于 dry-run 边界**：本 verb 产出 drain_respawn rollout 请求
 * 但**不真 POST**（真 POST 需 approvalId + release row + 在线 daemon = M5）。诚实标 blocked（铁律 4），
 * **绝不宣称 drain_respawn 已执行**——但交付**模式**已从 kill1 纠正为 drain_respawn。
 * 桌面通道是例外：它在 `PRISMER_UPDATE_FEED_DIR`（或 `--desktop-feed-dir`）内做真文件副作用，
 * 从 builder 元数据 plan → 原子 apply → 摘要 readback；该路径不发 HTTP、不读写真 Nacos。
 *
 * ## prod 人闸（不变量 2）
 * `--env prod` 硬拒，不做任何 OTA 动作。
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { Decision, decisionExit, emit, EXIT_BLOCKED, REPO_ROOT } from './release-common';

export type OtaEnv = 'dev' | 'test' | 'prod';

/** 线 3 正规下发的落点：admin fleet rollout endpoint（arm drain_respawn，非 kill1）。 */
export const ADMIN_ROLLOUT_ENDPOINT = 'POST /api/admin/runtime-releases/rollout';
/** endpoint 下发给 daemon 的帧；daemon 收到即排空在飞后 respawn（drain_respawn machinery）。 */
export const RUNTIME_UPDATE_APPLY_FRAME = 'runtime.update.apply';
/** 交付指令：drain_respawn（DaemonUpgradeDirective）——**不是** kill1。这是本 verb 的命根子。 */
export const DRAIN_RESPAWN_DIRECTIVE = 'drain_respawn' as const;

export interface K8sDrainRespawnRequest {
  /** 线 3 落点 = admin fleet rollout（不是线 1 的 runtime-ota.ts kill1）。 */
  channel: 'admin-fleet-rollout';
  endpoint: string;
  /** 交付指令：drain_respawn。kill1 会打断在飞 task；drain_respawn 排空后再 respawn（无中断）。 */
  directive: typeof DRAIN_RESPAWN_DIRECTIVE;
  /** endpoint → daemon 的帧（daemon arm drain_respawn）。 */
  frame: typeof RUNTIME_UPDATE_APPLY_FRAME;
  /** dry-run 出的 FleetRolloutBody（approvalId 是 M5 人闸，本机替身不带、不 POST）。 */
  request: { channel: 'daemon'; version: string; target: { type: 'all' } };
  /** 本机替身边界：不真 POST。true 只可能来自真 M5 路径。 */
  posted: false;
  /** 为何不 POST（诚实标注，铁律 4）。 */
  boundary: string;
}

/**
 * 构造线 3 drain_respawn fleet-rollout 请求（**不 spawn kill1、不 POST**）。
 * 交付 `directive:'drain_respawn'` 是相对旧 `kill 1` 的纠正——同一份 runtime，排空在飞后 respawn。
 */
export function buildDrainRespawnRollout(version: string): K8sDrainRespawnRequest {
  return {
    channel: 'admin-fleet-rollout',
    endpoint: ADMIN_ROLLOUT_ENDPOINT,
    directive: DRAIN_RESPAWN_DIRECTIVE, // ← 线 3：drain_respawn，绝非 kill1
    frame: RUNTIME_UPDATE_APPLY_FRAME,
    request: { channel: 'daemon', version, target: { type: 'all' } },
    posted: false, // 本机替身 dry-run 边界
    boundary: '真 admin rollout POST = M5（approvalId + release row + 在线 daemon）；本机替身只 dry-run',
  };
}

export interface DesktopBundleMeta {
  component: 'ui' | 'daemon';
  version: string;
  file: string;
  sha512: string;
  sig: string;
  size: number;
  minAppVersion: string;
}

export interface DesktopFeedComponent extends Omit<DesktopBundleMeta, 'component' | 'file'> {
  url: string;
}

export interface DesktopLocalFeedPlan {
  feedDir: string;
  manifestPath: string;
  manifest: {
    decision: 'ota';
    components: { ui?: DesktopFeedComponent; daemon?: DesktopFeedComponent };
  };
  copies: Array<{ component: 'ui' | 'daemon'; source: string; destination: string }>;
}

export interface DesktopFeedReadback {
  verified: boolean;
  decision: string | null;
  versions: { ui?: string; daemon?: string };
  errors: string[];
}

export type DesktopChannelResult =
  | {
      status: 'applied';
      deliveryMode: string;
      boundary: string;
      plan: DesktopLocalFeedPlan;
      readback: DesktopFeedReadback;
    }
  | {
      status: 'blocked';
      deliveryMode: string;
      boundary: string;
      blockers: string[];
      plan?: DesktopLocalFeedPlan;
      readback?: DesktopFeedReadback;
    };

export interface DesktopLocalFeedInput {
  feedDir: string;
  uiMetaPath?: string;
  daemonMetaPath?: string;
}

function sha512(path: string): string {
  return createHash('sha512').update(readFileSync(path)).digest('hex');
}

function readDesktopBundleMeta(metaPath: string, expected: 'ui' | 'daemon'): DesktopBundleMeta {
  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Partial<DesktopBundleMeta>;
  if (meta.component !== expected) throw new Error(`${metaPath} component=${String(meta.component)}，期望 ${expected}`);
  for (const field of ['version', 'file', 'sha512', 'sig', 'size', 'minAppVersion'] as const) {
    if (meta[field] === undefined || meta[field] === null || meta[field] === '') {
      throw new Error(`${metaPath} 缺字段 ${field}`);
    }
  }
  if (typeof meta.file !== 'string' || basename(meta.file) !== meta.file) {
    throw new Error(`${metaPath} 的 file 必须是 bundle basename`);
  }
  const source = resolve(dirname(metaPath), meta.file);
  if (!existsSync(source)) throw new Error(`bundle 不存在: ${source}`);
  if (statSync(source).size !== meta.size) throw new Error(`bundle size 与元数据不符: ${source}`);
  if (sha512(source) !== meta.sha512) throw new Error(`bundle sha512 与元数据不符: ${source}`);
  return meta as DesktopBundleMeta;
}

/** 只读：从 builder 的自验签元数据生成本机 feed 写入计划。 */
export function planDesktopLocalFeed(input: DesktopLocalFeedInput): DesktopLocalFeedPlan {
  if (!input.uiMetaPath && !input.daemonMetaPath) throw new Error('至少提供 ui 或 daemon bundle 元数据');
  const feedDir = resolve(input.feedDir);
  const components: DesktopLocalFeedPlan['manifest']['components'] = {};
  const copies: DesktopLocalFeedPlan['copies'] = [];
  for (const [component, metaPath] of [
    ['ui', input.uiMetaPath],
    ['daemon', input.daemonMetaPath],
  ] as const) {
    if (!metaPath) continue;
    const absoluteMetaPath = resolve(metaPath);
    const meta = readDesktopBundleMeta(absoluteMetaPath, component);
    const source = resolve(dirname(absoluteMetaPath), meta.file);
    const destination = resolve(feedDir, meta.file);
    if (existsSync(destination) && (statSync(destination).size !== meta.size || sha512(destination) !== meta.sha512)) {
      throw new Error(`本地 feed 的版本化 bundle 不可变，拒绝覆盖同名异字节文件: ${destination}`);
    }
    components[component] = {
      version: meta.version,
      url: meta.file,
      sha512: meta.sha512,
      sig: meta.sig,
      size: meta.size,
      minAppVersion: meta.minAppVersion,
    };
    copies.push({ component, source, destination });
  }
  return {
    feedDir,
    manifestPath: resolve(feedDir, 'manifest.json'),
    manifest: { decision: 'ota', components },
    copies,
  };
}

/** 写 bundle 后最后原子切 manifest；Electron 因而不会看到指向半复制 bundle 的新指针。 */
export function applyDesktopLocalFeed(plan: DesktopLocalFeedPlan): void {
  mkdirSync(plan.feedDir, { recursive: true });
  for (const copy of plan.copies) {
    const tmp = `${copy.destination}.tmp-${process.pid}`;
    copyFileSync(copy.source, tmp);
    renameSync(tmp, copy.destination);
  }
  const manifestTmp = `${plan.manifestPath}.tmp-${process.pid}`;
  const bytes = JSON.stringify(plan.manifest, null, 2) + '\n';
  writeFileSync(manifestTmp, bytes, 'utf8');
  renameSync(manifestTmp, plan.manifestPath);
}

/** 从 Electron 实际读取的 manifest/bundle 回读，不以 write 调用成功自证。 */
export function readbackDesktopLocalFeed(plan: DesktopLocalFeedPlan): DesktopFeedReadback {
  const errors: string[] = [];
  let manifest: DesktopLocalFeedPlan['manifest'] | null = null;
  try {
    manifest = JSON.parse(readFileSync(plan.manifestPath, 'utf8')) as DesktopLocalFeedPlan['manifest'];
  } catch (err) {
    errors.push(`manifest 回读失败: ${(err as Error).message}`);
  }
  if (manifest && JSON.stringify(manifest) !== JSON.stringify(plan.manifest)) errors.push('manifest 回读与计划不一致');
  for (const copy of plan.copies) {
    const component = plan.manifest.components[copy.component];
    if (!component || !existsSync(copy.destination)) {
      errors.push(`${copy.component} bundle 回读缺失`);
      continue;
    }
    if (statSync(copy.destination).size !== component.size || sha512(copy.destination) !== component.sha512) {
      errors.push(`${copy.component} bundle 回读摘要不一致`);
    }
  }
  return {
    verified: errors.length === 0,
    decision: manifest?.decision ?? null,
    versions: {
      ...(manifest?.components.ui ? { ui: manifest.components.ui.version } : {}),
      ...(manifest?.components.daemon ? { daemon: manifest.components.daemon.version } : {}),
    },
    errors,
  };
}

export function promoteDesktopLocalFeed(input: DesktopLocalFeedInput): DesktopChannelResult {
  const boundary = '本机 feed 已发布并回读不等于 Electron 已 check/stage/apply；客户端两段式触达须另取运行态证据';
  try {
    const plan = planDesktopLocalFeed(input);
    applyDesktopLocalFeed(plan);
    const readback = readbackDesktopLocalFeed(plan);
    if (!readback.verified) {
      return { status: 'blocked', deliveryMode: 'local-file-feed', boundary, blockers: readback.errors, plan, readback };
    }
    return { status: 'applied', deliveryMode: 'local-file-feed', boundary, plan, readback };
  } catch (err) {
    return { status: 'blocked', deliveryMode: 'local-file-feed', boundary, blockers: [(err as Error).message] };
  }
}

export interface OtaPromoteReport {
  verb: 'ota-promote';
  decision: Decision;
  env: OtaEnv;
  deliveryMode: string;
  k8s: K8sDrainRespawnRequest | { skipped: true; reason: string };
  desktop: DesktopChannelResult;
  blockers: string[];
  notes: string[];
}

const USAGE = `apc release ota-promote [--env dev|test|prod] [--json]

线 3 admin fleet OTA promote（apc/01 §2，治 doc01 #8）：
  K8s 通道 → 构造 drain_respawn rollout 请求（落点 ${ADMIN_ROLLOUT_ENDPOINT}，帧 ${RUNTIME_UPDATE_APPLY_FRAME}）
             **不再 spawn kill1 的 runtime-ota.ts**；本机替身只 dry-run，不真 POST（= M5）
  桌面通道 → --desktop-feed-dir <dir> [--desktop-ui-meta <path>] [--desktop-daemon-meta <path>]
             plan → 复制已签名 bundle → 原子切 manifest → 回读摘要；只写本机文件，不触 Nacos
  --env prod → 人闸硬拒(1)
  exit 0 green（真 rollout 完成，仅 M5）· 1 blocked（本机替身 dry-run 边界 / 桌面未接线 / prod 人闸）
`;

function readVersion(): string {
  try {
    return readFileSync(join(REPO_ROOT, 'VERSION'), 'utf8').trim();
  } catch {
    return '0.0.0';
  }
}

export async function main(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const json = argv.includes('--json');
  const env = (argVal(argv, '--env') ?? 'dev') as OtaEnv;

  let desktop: DesktopChannelResult = {
    status: 'blocked',
    deliveryMode: 'local-file-feed',
    boundary: '未配置本机 feed；未读写真 Nacos，未触发 Electron check/stage/apply',
    blockers: ['未配置 --desktop-feed-dir（或 PRISMER_UPDATE_FEED_DIR）'],
  };
  const blockers: string[] = [];
  const notes: string[] = [
    `线 3 正规 fleet 下发 = drain_respawn（${ADMIN_ROLLOUT_ENDPOINT} → ${RUNTIME_UPDATE_APPLY_FRAME} → daemon 排空在飞后 respawn，无中断）；本 verb 不再走线 1 kill1`,
    '本机替身：只 dry-run 出 drain_respawn rollout 请求，不真 POST（真 POST = M5：approvalId + release row + 在线 daemon）',
  ];

  // prod 人闸：先于任何 OTA 动作
  if (env === 'prod') {
    const report: OtaPromoteReport = {
      verb: 'ota-promote',
      decision: 'blocked',
      env,
      deliveryMode: 'drain_respawn（线 3）· prod 人闸阻断',
      k8s: { skipped: true, reason: 'prod 人闸（不变量 2）：本机替身拒绝 prod OTA，真 prod = M5' },
      desktop,
      blockers: ['prod 人闸：ota-promote 拒绝 --env prod（真 prod promote = M5）'],
      notes,
    };
    await emit(json, `[ota-promote] BLOCKED prod 人闸`, report as unknown as Record<string, unknown>);
    return EXIT_BLOCKED;
  }

  const feedDir = argVal(argv, '--desktop-feed-dir') ?? process.env.PRISMER_UPDATE_FEED_DIR?.trim();
  if (feedDir) {
    const defaultUiMeta = join(REPO_ROOT, 'apps/desktop/dist-ui/ui.manifest.json');
    const defaultDaemonMeta = join(REPO_ROOT, 'apps/desktop/dist-ui/daemon.manifest.json');
    const explicitUiMeta = argVal(argv, '--desktop-ui-meta');
    const explicitDaemonMeta = argVal(argv, '--desktop-daemon-meta');
    const useDefaults = !explicitUiMeta && !explicitDaemonMeta;
    desktop = promoteDesktopLocalFeed({
      feedDir,
      uiMetaPath: explicitUiMeta ?? (useDefaults && existsSync(defaultUiMeta) ? defaultUiMeta : undefined),
      daemonMetaPath: explicitDaemonMeta ?? (useDefaults && existsSync(defaultDaemonMeta) ? defaultDaemonMeta : undefined),
    });
  }

  // 线 3 K8s 通道：构造 drain_respawn rollout 请求（不 spawn kill1、不 POST）。
  const k8s = buildDrainRespawnRollout(readVersion());
  blockers.push(
    '真 admin drain_respawn rollout POST 未执行（需 approvalId + release row + 在线 daemon = M5）；本机替身只 dry-run 出请求',
  );

  if (desktop.status === 'blocked') blockers.push(...desktop.blockers.map((b) => `桌面本地 feed: ${b}`));

  // 双通道任一未完成都不能把顶层 decision 报绿。
  const decision: Decision = blockers.length === 0 ? 'green' : 'blocked';

  const report: OtaPromoteReport = {
    verb: 'ota-promote',
    decision,
    env,
    deliveryMode: `${DRAIN_RESPAWN_DIRECTIVE}（线 3 admin fleet rollout · 本机替身 dry-run）`,
    k8s,
    desktop,
    blockers,
    notes,
  };

  await emit(
    json,
    [
      `[ota-promote] decision=${decision} env=${env}`,
      `  k8s: channel=${k8s.channel} directive=${k8s.directive} frame=${k8s.frame} posted=${k8s.posted}`,
      `  desktop: ${desktop.status}${desktop.status === 'applied' ? ` (readback=${desktop.readback.verified})` : ''}`,
      ...blockers.map((b) => `  ✗ ${b}`),
      ...notes.map((n) => `  · ${n}`),
    ].join('\n'),
    report as unknown as Record<string, unknown>,
  );

  return decisionExit(decision);
}

function argVal(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}
