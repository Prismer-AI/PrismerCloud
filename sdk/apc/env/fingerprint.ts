#!/usr/bin/env npx tsx
/**
 * fingerprint.ts — `apc env fingerprint`（apc/06 §2）。**机器等价性证明**：
 * 工具链版本 + key 存在性位图 + schema revision + binary pin → 一个可比对的指纹串。
 *
 * ## E4：复用不重造（doc 06 §2 明写，doc 13 E4 记的欠账）
 *
 * 上一轮 fingerprint **零 import test204**、firstSemver/toolVersion 全部重写。这次三处
 * 真 import：
 *
 *   `scripts/test204/lib/manifest.ts`   → `collectHardware` / `collectGitHead` / `collectKind`
 *                                          / `collectNacosFingerprint` / `NacosFingerprint`
 *   `scripts/test204/lib/machine-gate.ts` → `EnvError` / `isEnvError`（环境故障域 vs 断言失败
 *                                          的**类型级**分域纪律，绝不混判）
 *   `scripts/test204/lib/env-preflight.ts`（经 collectKind 间接）→ `inspectKind` 的 kind 判定
 *
 * `__tests__/fingerprint.test.ts` 直接断言这些符号来自 test204（不是本地同名副本）。
 *
 * ## 密钥只进位图
 *
 * key 存在性用 `1/0` 位图记，**永不记值、永不记长度、永不记 hash**（hash 也是值的函数）。
 */
import { createHash } from 'node:crypto';
import {
  collectGitHead,
  collectHardware,
  collectKind,
  collectNacosFingerprint,
} from '../../../scripts/test204/lib/manifest';
import { isEnvError } from '../../../scripts/test204/lib/machine-gate';
import type { Hardware, KindFingerprint, NacosFingerprint } from '../../../scripts/test204/lib/manifest';
import {
  DEV_CREDENTIAL_KEYS,
  KIND_CLUSTER,
  REQUIRED_ENV_KEYS,
  readBinaryPins,
  readNodeMajorPin,
  checkVersionAlignment,
} from './manifest';
import { binaryVersion, mysqlProbe, readEnvLocal, resolveEnvValue, writeStdout } from './probes';

export interface EnvFingerprint {
  /** 指纹串：对下面 `material` 的稳定序列化取 sha256。两台机相同 ⇒ 环境等价。 */
  fingerprint: string;
  generatedAt: string;
  gitHead: string;
  /** 硬件真值（test204 `collectHardware`，§7.3.0：基线数字得知道在什么机器上量的）。 */
  hardware: Hardware;
  /** kind 指纹（test204 `collectKind` → `inspectKind`）。 */
  kind: KindFingerprint & { cluster: string };
  /**
   * Nacos 指纹（test204 `collectNacosFingerprint`，三门）。
   * 门抛 `EnvError` 时不吞：记 `gateError`，指纹里明示**这台机的配置一致性没被验过**。
   */
  nacos: NacosFingerprint | { gateError: string };
  /** 工具链真实版本 + manifest pin，逐项并列（不比对，比对是 doctor 的活）。 */
  toolchain: Record<string, { installed: string | null; pin: string | null }>;
  /** key 存在性**位图**——只有 1/0，没有值。 */
  keyBitmap: Record<string, 0 | 1>;
  /** schema revision：本机 `schema_migrations` 账本行数 + head 文件名。 */
  schema: { ledgerRows: number | null; ledgerHead: string | null; error?: string };
  /** /VERSION 与版本文件对齐结果。 */
  version: { version: string; aligned: boolean; mismatched: string[] };
  /** 参与 hash 的规范化材料（可读，便于两机 diff 定位差在哪一项）。 */
  material: Record<string, string>;
}

export async function fingerprint(envLocal: Map<string, string> = readEnvLocal()): Promise<EnvFingerprint> {

  const hardware = collectHardware();
  const gitHead = await collectGitHead().catch(() => 'unknown');
  const kindRaw = await collectKind().catch((e: unknown) => ({
    present: false,
    healthy: false,
    probeError: e instanceof Error ? e.message : String(e),
  }));

  let nacos: EnvFingerprint['nacos'];
  {
    // `ensureNacosConfig()`（collectNacosFingerprint 内部）往 **console.log** 打一串
    // `[Nacos] …` —— 那会污染 stdout 的 JSON 通道。把 console.log 临时改道 stderr：
    // 日志不丢（仍可见），stdout 保持纯净。
    const realLog = console.log;
    console.log = (...a: unknown[]) => process.stderr.write(a.map(String).join(' ') + '\n');
    try {
      // allowConfigDrift：门 3/3′ 违规降级为 manifest 里的 loud WARN 字段而不是 throw
      // （test204 manifest.ts 文件头的既定语义），门 1/2 依旧硬 —— 抛出来就如实记 gateError。
      nacos = await collectNacosFingerprint({ allowConfigDrift: true });
    } catch (e) {
      nacos = { gateError: `${isEnvError(e) ? 'EnvError' : 'Error'}: ${e instanceof Error ? e.message : String(e)}` };
    } finally {
      console.log = realLog;
    }
  }

  const pins = readBinaryPins();
  const nodePin = readNodeMajorPin();
  const toolchain: EnvFingerprint['toolchain'] = {
    node: { installed: process.versions.node, pin: nodePin ? `${nodePin.major}.x` : null },
  };
  for (const [bin, pinName, args] of [
    ['claude', 'claude', undefined],
    ['codex', 'codex', undefined],
    ['opencode', 'opencode', undefined],
    ['hermes', 'hermes', undefined],
    // kubectl 没有 `--version`（会 `error: unknown flag`），真形式是 `version --client`。
    ['kubectl', null, ['version', '--client']],
    ['kind', null, undefined],
  ] as Array<[string, string | null, string[] | undefined]>) {
    const v = await binaryVersion(bin, args);
    toolchain[bin] = { installed: v?.semver ?? v?.raw ?? null, pin: pinName ? (pins[pinName] ?? null) : null };
  }

  const keyBitmap: Record<string, 0 | 1> = {};
  for (const { key } of REQUIRED_ENV_KEYS) keyBitmap[key] = resolveEnvValue(key, envLocal) ? 1 : 0;
  for (const key of DEV_CREDENTIAL_KEYS) keyBitmap[key] = resolveEnvValue(key, envLocal) ? 1 : 0;

  const dbUrl = resolveEnvValue('DATABASE_URL', envLocal);
  let schema: EnvFingerprint['schema'] = { ledgerRows: null, ledgerHead: null, error: 'DATABASE_URL 缺失' };
  if (dbUrl?.startsWith('mysql://')) {
    const p = await mysqlProbe(dbUrl);
    schema = p.ok
      ? { ledgerRows: p.ledgerRows ?? null, ledgerHead: p.ledgerHead ?? null }
      : { ledgerRows: null, ledgerHead: null, error: p.error };
  }

  const va = checkVersionAlignment();

  // 规范化材料：按 key 排序拼接，两台机 diff 时能直接看出差在哪一项。
  const material: Record<string, string> = {
    'hardware.arch': hardware.arch,
    'hardware.os': hardware.os,
    'kind.cluster': KIND_CLUSTER,
    'kind.present': String(kindRaw.present),
    'nacos.namespace': 'gateError' in nacos ? `ERR(${nacos.gateError.slice(0, 60)})` : nacos.namespace,
    'nacos.contentHash': 'gateError' in nacos ? 'null' : (nacos.contentHash ?? 'null'),
    'schema.head': schema.ledgerHead ?? 'null',
    'schema.rows': String(schema.ledgerRows ?? 'null'),
    'version.VERSION': va.version,
    'version.aligned': String(va.ok),
  };
  for (const [k, v] of Object.entries(toolchain)) material[`tool.${k}`] = `${v.installed ?? 'absent'}@pin=${v.pin ?? 'none'}`;
  for (const [k, v] of Object.entries(keyBitmap)) material[`key.${k}`] = String(v);

  const canonical = Object.keys(material)
    .sort()
    .map((k) => `${k}=${material[k]}`)
    .join('\n');

  return {
    fingerprint: `sha256:${createHash('sha256').update(canonical).digest('hex')}`,
    generatedAt: new Date().toISOString(),
    gitHead,
    hardware,
    kind: { ...kindRaw, cluster: KIND_CLUSTER },
    nacos,
    toolchain,
    keyBitmap,
    schema,
    version: { version: va.version, aligned: va.ok, mismatched: va.mismatched },
    material,
  };
}

export function renderHuman(fp: EnvFingerprint): string {
  const lines = [`[apc env fingerprint] ${fp.fingerprint}`, `  git ${fp.gitHead.slice(0, 12)} · ${fp.hardware.os} ${fp.hardware.arch}`];
  for (const k of Object.keys(fp.material).sort()) lines.push(`  ${k} = ${fp.material[k]}`);
  return lines.join('\n');
}

export async function main(): Promise<number> {
  const fp = await fingerprint();
  await writeStdout(JSON.stringify(fp, null, 2) + '\n');
  process.stderr.write(renderHuman(fp) + '\n');
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`[apc env fingerprint] 崩溃：${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exit(1);
    },
  );
}
