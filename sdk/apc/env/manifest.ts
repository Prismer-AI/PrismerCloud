/**
 * manifest.ts — env-manifest 四段清单（apc/06 §1）。**声明式**：一台合格开发机需要什么
 * 全在这里，不散落在人脑 / README / memory。
 *
 * ## 反开卷纪律（apc/11 §1 铁律 2/4）
 *
 * 「硬编码常量互相比较 = 开卷」。所以本文件里的 pin **一个都不硬编码**，全部从仓库里
 * 那份 canonical 源**当场读**：
 *
 *   node major       ← `Dockerfile:1`（`FROM node:20-alpine`）
 *   claude / codex / opencode 二进制 pin ← `infra/sandbox-image/image-pin.yaml` 的 `binaries:` 块
 *   版本对齐          ← `/VERSION` ⇄ 各 package.json / plugin.json 真读
 *   node_modules 一致 ← `package-lock.json` ⇄ `node_modules/<pkg>/package.json` **逐包比对**
 *
 * 源漂了 doctor 就跟着漂——这是要的：manifest 不是第二份真相，是对 canonical 源的**取值器**。
 *
 * ## id 命名的承重约束
 *
 * `scripts/test203/run.ts::TIER_ENV_REQUIRES`（run.ts:234）按**子串**匹配：
 * T3 需 `cloud`，T4 需 `mysql` / `redis` / `cloud`。id 改名前先跑
 * `__tests__/run-ts-contract.test.ts`（它 import 真 `parseExternalDoctor` 验）。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  REPO_ROOT,
  binaryVersion,
  httpProbe,
  kindProbe,
  mysqlProbe,
  nacosBaseUrl,
  nacosHealth,
  readEnvLocal,
  redactUrl,
  redisProbe,
  resolveEnvValue,
  run,
  runBash,
  which,
} from './probes';
import type { EnvItem, ItemResult } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// canonical 源取值器（禁硬编码 pin）
// ─────────────────────────────────────────────────────────────────────────────

/** node 大版本 pin ← `Dockerfile` 第一行 `FROM node:<major>-alpine`（部署镜像即真相）。 */
export function readNodeMajorPin(repoRoot = REPO_ROOT): { major: string; source: string } | null {
  const f = path.join(repoRoot, 'Dockerfile');
  if (!existsSync(f)) return null;
  const m = /^FROM\s+node:(\d+)[-.]/m.exec(readFileSync(f, 'utf8'));
  return m ? { major: m[1]!, source: 'Dockerfile FROM node:<major>' } : null;
}

export interface BinaryPins {
  [name: string]: string;
}

/**
 * 三个 coding agent 二进制 pin ← `infra/sandbox-image/image-pin.yaml` 的 `binaries:` 块。
 *
 * 为什么是这份而不是 runtime 的 `known-versions.ts`：06 §5 明确 **APC 不反向 import
 * runtime 源码**。image-pin.yaml 是 infra 侧的 canonical pin，且 known-versions.ts 的注释
 * 本身就要求两处对齐 —— 对齐性由 `__tests__/source-contract.test.ts` 当契约测试盯着
 * （读 runtime 源**文本**，不 import）。
 */
export function readBinaryPins(repoRoot = REPO_ROOT): BinaryPins {
  const f = path.join(repoRoot, 'infra', 'sandbox-image', 'image-pin.yaml');
  if (!existsSync(f)) return {};
  const doc = parseYaml(readFileSync(f, 'utf8')) as { binaries?: Record<string, { version?: string }> };
  const out: BinaryPins = {};
  for (const [k, v] of Object.entries(doc?.binaries ?? {})) if (v?.version) out[k] = String(v.version);
  return out;
}

/** `sdk/build/version.sh` 会 bump 的版本文件（该脚本 :112-149 逐条列出）。 */
export const VERSION_FILES: string[] = [
  'package.json',
  'apps/desktop/package.json',
  'sdk/cloud/package.json',
  'sdk/prismer/package.json',
  'sdk/cloud/mcp/package.json',
  'sdk/aip/typescript/package.json',
];

/**
 * `.env.local` 必需键（06 §1 密钥/配置段）。每条都有 **grep 到的真消费者**——
 * 清单不是凭印象列的。
 */
export const REQUIRED_ENV_KEYS: Array<{ key: string; consumer: string }> = [
  { key: 'DATABASE_URL', consumer: 'src/lib/prisma.ts:16' },
  { key: 'REDIS_URL', consumer: 'src/lib/runtime-presence.ts:4' },
  { key: 'JWT_SECRET', consumer: 'src/lib/auth/verify-jwt.ts:24' },
  // KEK 双 key（CLAUDE.md「product204 M6 secret KEK」；缺失显式失败，不是 flag）
  { key: 'IDENTITY_KMS_KEY', consumer: 'src/im/services/identity-key-vault.ts:30' },
  { key: 'SKILL_CONFIG_ENC_KEY', consumer: 'src/lib/skill-config-crypto.ts:30' },
  { key: 'EXASEARCH_API_KEY', consumer: 'src/lib/web-search.ts:55' },
];

/** 「DEV_JWT 或 api-key」——任一在场即可（06 §1）。 */
export const DEV_CREDENTIAL_KEYS = ['DEV_JWT', 'PRISMER_API_KEY_DEV', 'PRISMER_API_KEY'];

/** OTA UI 签名私钥（M3 硬前置，06 §1）。 */
export const OTA_SIGNING_KEY = 'apps/desktop/.keys/ota-ui-private.pem';

/** kind 集群名（`scripts/sandbox/dev-loop.sh:37` 的 `CLUSTER_NAME` 默认值）。 */
export const KIND_CLUSTER = process.env.CLUSTER_NAME ?? 'prismer-sandbox';

/**
 * bare-repo 替身（04 §4.5 / 06 §1 工程态）：release-tag 的 push 边界打这里，不推远端。
 * 落 `.dev-stack/`（已 gitignore，dev 基础设施同域）。
 */
export const BARE_MIRROR = path.join('.dev-stack', 'apc-bare-origin.git');

/**
 * spawned Claude Code 的隔离 config 目录（D2）。
 *
 * ⚠️ 这里**复制**了 runtime `config-isolation.ts` 的路径构成（06 §5 禁止 APC 反向 import
 * runtime 源码）。复制 = 会漂 → `__tests__/source-contract.test.ts` 读 runtime **源文本**
 * 钉住这两段（`.prismer` / `claude-config` / `.claude`），任一侧改了就红。
 * 这正是 doc 13 K5 那条「硬编码**错**路径还恒真」的反面。
 */
export function isolatedClaudeConfigDir(home = os.homedir()): string {
  return path.join(home, '.prismer', 'claude-config', '.claude');
}

/**
 * APC 专属工具前缀（用户裁决 2026-07-24）。
 *
 * ⚠️ **跨 sdk/apc ↔ runtime 的约定常量**：runtime 侧 spawn coding adapter 时必须用这里
 * 锁定的 binary，而不是开发者 PATH 上的日常 `claude`（那个随时会被 `npm i -g` 升成
 * 别的版本，静默破坏 adapter——coding adapter 是写死针对单一 CLI 版本行为开发的，exact
 * pin 就是要拦住这种漂移）。**APC 不许 import runtime（06 §5 依赖方向铁律），所以这个
 * 路径两侧各写一份 → 改一侧必须改另一侧。** 同一 `.prismer` 家族，与 `isolatedClaudeConfigDir`
 * 的 `~/.prismer/claude-config` 保持一致。
 */
export function apcToolsPrefix(home = os.homedir()): string {
  return path.join(home, '.prismer', 'apc-tools');
}

/** APC 锁定的 claude-code binary 绝对路径（`npm i --prefix <apcToolsPrefix>` 装出来的 bin）。 */
export function apcPinnedClaudeBinary(home = os.homedir()): string {
  return path.join(apcToolsPrefix(home), 'bin', 'claude');
}

/** 本机网关口径（hermes/coding agent 都吃它）。真值从 `/api/models` 拉，这里只是**期望集**。 */
export const EXPECTED_GATEWAY_MODELS: Array<{ provider: string; model: string }> = [
  { provider: 'newapi', model: 'us-kimi-k2.6' },
  { provider: 'deepseek', model: 'deepseek-v4-flash' },
];

export const CLOUD_DEV_URL = process.env.APC_CLOUD_URL ?? 'http://127.0.0.1:3000';

// ─────────────────────────────────────────────────────────────────────────────
// 段 1：infra
// ─────────────────────────────────────────────────────────────────────────────

const infraItems: EnvItem[] = [
  {
    id: 'infra.docker-daemon',
    section: 'infra',
    label: 'docker daemon（colima / OrbStack / Docker Desktop）',
    strength: 'process',
    fixHint: 'colima start   # 或 open -a OrbStack / Docker Desktop，然后 docker info 确认',
    async check(): Promise<ItemResult> {
      const r = await run('docker', ['info', '--format', '{{.ServerVersion}}'], 15_000);
      return r.ok
        ? { status: 'pass', detail: `docker server ${r.stdout}` }
        : { status: 'fail', detail: `docker info 失败：${r.error}` };
    },
  },
  {
    id: 'infra.mysql-3307',
    section: 'infra',
    label: 'MySQL :3307 协议级可连（握手 + SELECT VERSION()）',
    strength: 'protocol',
    fixHint: 'npm run dev:stack   # docker-compose.dev.yml 起 mysql:8.0（:3307）',
    async check(): Promise<ItemResult> {
      const url = resolveEnvValue('DATABASE_URL');
      if (!url) return { status: 'skip', detail: 'DATABASE_URL 未配置 → 无法判定（≠ 无问题）' };
      if (!url.startsWith('mysql://'))
        return { status: 'skip', detail: `DATABASE_URL 非 mysql://（${redactUrl(url)}）→ 本判定只覆盖 MySQL` };
      const p = await mysqlProbe(url);
      return p.ok
        ? { status: 'pass', detail: `${redactUrl(url)} → MySQL ${p.version}（真握手 + 查询）` }
        : { status: 'fail', detail: `${redactUrl(url)} 协议级连接失败：${p.error}` };
    },
  },
  {
    id: 'infra.mysql-migration-ledger',
    section: 'infra',
    label: '迁移账本 schema_migrations 健康（本机 canonical 账本表）',
    strength: 'protocol',
    fixHint: 'npm run db:migrate:baseline   # 干净/遗留库一次性 seed 账本；随后 npm run db:migrate',
    async check(): Promise<ItemResult> {
      const url = resolveEnvValue('DATABASE_URL');
      if (!url || !url.startsWith('mysql://')) return { status: 'skip', detail: 'DATABASE_URL 缺失/非 MySQL → 未检测' };
      const p = await mysqlProbe(url);
      if (!p.ok) return { status: 'skip', detail: `MySQL 不可连，账本未检测：${p.error}` };
      if (p.ledgerRows === null)
        return {
          status: 'fail',
          detail:
            'schema_migrations 表不存在 —— 本机 canonical 账本是 schema_migrations（scripts/db-migrate.sh:81），' +
            '`_migrations` 是远端 sync 的账本（scripts/ops/sync-test-migrations.ts），不是这台机的',
        };
      if ((p.ledgerRows ?? 0) === 0) return { status: 'fail', detail: 'schema_migrations 存在但 0 行（账本未 seed）' };
      return { status: 'pass', detail: `schema_migrations ${p.ledgerRows} 行，head=${p.ledgerHead ?? 'n/a'}` };
    },
  },
  {
    id: 'infra.redis-6380',
    section: 'infra',
    label: 'Redis :6380 协议级 PING → PONG',
    strength: 'protocol',
    fixHint: 'npm run dev:stack   # docker-compose.dev.yml 起 redis:7-alpine（:6380）',
    async check(): Promise<ItemResult> {
      const url = resolveEnvValue('REDIS_URL');
      if (!url) return { status: 'skip', detail: 'REDIS_URL 未配置 → 未检测' };
      const p = await redisProbe(url);
      return p.ok
        ? { status: 'pass', detail: `${redactUrl(url)} → PONG（redis ${p.serverVersion ?? '?'}）` }
        : { status: 'fail', detail: `${redactUrl(url)} RESP PING 失败：${p.error}` };
    },
  },
  {
    id: 'infra.nacos',
    section: 'infra',
    label: 'Nacos HTTP health readiness（2.x 必须走 HTTP API）',
    strength: 'protocol',
    fixHint:
      '确认 CONFIG_CENTER_IP / 网络（VPN）能到 Nacos；namespace 由 APP_ENV 决定（src/lib/nacos-config.ts:57）',
    async check(): Promise<ItemResult> {
      const base = nacosBaseUrl();
      const p = await nacosHealth(base);
      if (!p.ok) return { status: 'fail', detail: `${base}/nacos/v1/console/health/readiness → ${p.status ?? p.error}` };
      const body = (p.body ?? '').trim();
      if (!/^ok$/i.test(body))
        return { status: 'fail', detail: `${base} readiness HTTP ${p.status} 但 body=${JSON.stringify(body.slice(0, 80))}` };
      return { status: 'pass', detail: `${base} readiness HTTP ${p.status} ${body}（APP_ENV=${process.env.APP_ENV ?? 'dev(默认)'}）` };
    },
  },
  {
    id: `infra.kind-${KIND_CLUSTER}`,
    section: 'infra',
    label: `kind 集群 ${KIND_CLUSTER} 的 API server 可达且节点 Ready`,
    strength: 'protocol',
    fixHint: 'bash scripts/sandbox/dev-loop.sh up   # 建/修 kind 集群',
    async check(): Promise<ItemResult> {
      const p = await kindProbe(KIND_CLUSTER);
      if (!p.clusterListed) return { status: 'fail', detail: `kind 无集群 ${KIND_CLUSTER}：${p.error}` };
      if (p.nodesTotal === undefined) return { status: 'fail', detail: `kubectl 打 kind-${KIND_CLUSTER} API server 失败：${p.error}` };
      return p.ok
        ? { status: 'pass', detail: `kind-${KIND_CLUSTER} API server 可达，节点 ${p.nodesReady}/${p.nodesTotal} Ready` }
        : { status: 'fail', detail: `kind-${KIND_CLUSTER} 节点 ${p.nodesReady}/${p.nodesTotal} Ready` };
    },
  },
  {
    id: 'infra.cloud-dev-server',
    section: 'infra',
    label: 'cloud dev server :3000 /api/health',
    strength: 'protocol',
    fixHint: 'npm run dev   # 起完整收敛的本地产品',
    async check(): Promise<ItemResult> {
      // 消费者契约：`scripts/test203/run.ts::TIER_ENV_REQUIRES` 的 T3/T4 按子串 'cloud' 找这一项。
      const p = await httpProbe(`${CLOUD_DEV_URL}/api/health`, { timeoutMs: 6_000 });
      if (!p.ok) return { status: 'fail', detail: `${CLOUD_DEV_URL}/api/health → ${p.status ?? p.error}` };
      try {
        const j = JSON.parse(p.body ?? '{}') as { status?: string; version?: string; checks?: Record<string, { status?: string }> };
        const db = j.checks?.database?.status;
        if (j.status !== 'healthy' || db !== 'up')
          return { status: 'fail', detail: `health 200 但 status=${j.status} database=${db}` };
        return { status: 'pass', detail: `healthy v${j.version} database=${db} im=${j.checks?.im?.status}` };
      } catch {
        return { status: 'fail', detail: `health 200 但 body 非 JSON：${(p.body ?? '').slice(0, 120)}` };
      }
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 段 2：工具链
// ─────────────────────────────────────────────────────────────────────────────

/**
 * E6 的判据本体：取到版本**必须与 pin 比对**，不许恒 `ok:true`。
 *
 * 抽成导出的纯函数是为了让负控**真变异**得了输入（`__tests__/manifest.test.ts` 直接
 * 拿真实版本 + 篡改过的 pin 调它，断言结论翻红）——判据藏在闭包里就只能靠"看代码相信它"，
 * 那是开卷。
 */
export function compareToPin(
  installed: { raw: string; semver: string | null } | null,
  pin: string | undefined,
  ctx: { bin: string; pinName: string },
): ItemResult {
  if (!installed) return { status: 'fail', detail: `${ctx.bin} 不在 PATH 上（或 --version 无输出）` };
  if (!pin)
    return {
      status: 'skip',
      detail: `装的是 ${installed.semver ?? installed.raw}，但 image-pin.yaml binaries.${ctx.pinName} 无 pin → 无从比对（未检测）`,
    };
  if (installed.semver !== pin)
    return {
      status: 'fail',
      detail: `装的是 ${installed.semver ?? installed.raw}，pin 是 ${pin}（源 infra/sandbox-image/image-pin.yaml binaries.${ctx.pinName}）`,
    };
  return { status: 'pass', detail: `${installed.semver} == pin ${pin}` };
}

const toolchainItems: EnvItem[] = [
  {
    id: 'toolchain.node',
    section: 'toolchain',
    label: 'node 大版本 == 部署镜像 pin',
    strength: 'version',
    fixHint: 'nvm install 20 && nvm use 20   # 与 Dockerfile 的 node:20-alpine 对齐',
    async check(): Promise<ItemResult> {
      const pin = readNodeMajorPin();
      const actual = process.versions.node;
      if (!pin) return { status: 'skip', detail: `Dockerfile 未解析出 node pin；本机 ${actual} → 未检测` };
      const major = actual.split('.')[0]!;
      return major === pin.major
        ? { status: 'pass', detail: `node ${actual}，major == pin ${pin.major}（${pin.source}）` }
        : { status: 'fail', detail: `node ${actual}，major ${major} ≠ pin ${pin.major}（${pin.source}）` };
    },
  },
  {
    id: 'toolchain.docker-compose',
    section: 'toolchain',
    label: 'docker compose 插件在位',
    strength: 'process',
    fixHint: '安装 docker compose v2（OrbStack / Docker Desktop 自带）',
    async check(): Promise<ItemResult> {
      const r = await run('docker', ['compose', 'version'], 15_000);
      return r.ok ? { status: 'pass', detail: r.stdout } : { status: 'fail', detail: `docker compose version 失败：${r.error}` };
    },
  },
  {
    id: 'toolchain.kubectl',
    section: 'toolchain',
    label: 'kubectl 在 PATH',
    strength: 'presence',
    fixHint: 'brew install kubectl',
    async check(): Promise<ItemResult> {
      const p = await which('kubectl');
      return p ? { status: 'pass', detail: p } : { status: 'fail', detail: 'kubectl 不在 PATH' };
    },
  },
  {
    id: 'toolchain.kind-cli',
    section: 'toolchain',
    label: 'kind CLI 在 PATH',
    strength: 'presence',
    fixHint: 'brew install kind',
    async check(): Promise<ItemResult> {
      const p = await which('kind');
      return p ? { status: 'pass', detail: p } : { status: 'fail', detail: 'kind 不在 PATH' };
    },
  },
  {
    // D1：**唯一保留的 coding adapter**（用户裁决 2026-07-24：APC 只锁 claude-code；
    // codex/opencode 从 doctor 工具链检查里拿掉——image-pin.yaml 里它们的条目是 infra 侧的，
    // 不动那份 yaml，只是 apc doctor 不再检查）。
    //
    // 关键错位修正：doctor **不**检查 PATH 上开发者日常的 `claude`（会被随手 `npm i -g` 升级），
    // 而是检查 APC 专属前缀里锁定的绝对路径 binary（`apcPinnedClaudeBinary`）。exact 精确锁定
    // 不变——floor 会放行上游漂移，而 coding adapter 写死针对单一版本行为，漂移 = 静默破坏。
    id: 'toolchain.claude-code-binary-pin',
    section: 'toolchain',
    label: 'APC 锁定 claude-code binary == pin（D1，exact；查 ~/.prismer/apc-tools 非 PATH）',
    strength: 'version',
    fixHint: 'apc env up   # 装锁定版本到 ~/.prismer/apc-tools（npm i --prefix，pin 见 image-pin.yaml binaries.claude）',
    async check(): Promise<ItemResult> {
      const pin = readBinaryPins()['claude'];
      const abs = apcPinnedClaudeBinary();
      if (!existsSync(abs))
        return {
          status: 'fail',
          detail: `锁定 binary 未装：${abs} 不存在（PATH 上的日常 claude 不算数）→ 跑 \`apc env up\` 装 pin=${pin ?? '?'} 版本`,
        };
      // exact 比对（compareToPin），judge 判据与其它 version 项同源，不削薄。
      const v = await binaryVersion(abs);
      return compareToPin(v, pin, { bin: abs, pinName: 'claude' });
    },
  },
  {
    id: 'toolchain.hermes-binary',
    section: 'toolchain',
    label: 'hermes CLI 在位并可执行（**只判二进制，不代表网关口径**）',
    strength: 'presence',
    fixHint: '按 Hermes Agent 安装文档装 hermes；本机路径通常是 ~/.local/bin/hermes',
    async check(): Promise<ItemResult> {
      const v = await binaryVersion('hermes');
      if (!v) return { status: 'fail', detail: 'hermes 不在 PATH（或 --version 无输出）' };
      // E1 诚实措辞：这一项**只**证明二进制在且能跑。adapter/网关口径由下一项独立判定。
      // image-pin.yaml 无 hermes pin（known-versions 也是 minVersion 0.0.0 的 honesty rule），
      // 所以这里不做版本比对，也不声称比对过。
      return { status: 'pass', detail: `${v.raw}（未比对 pin：image-pin.yaml / known-versions 对 hermes 均无 pin）` };
    },
  },
  {
    id: 'toolchain.hermes-gateway-models',
    section: 'toolchain',
    label: '本机网关口径真探活：curated model list 含 us-kimi-k2.6 / deepseek-v4-flash',
    strength: 'protocol',
    fixHint:
      '起 cloud（npm run dev）并在 .env.local 配 PRISMER_API_KEY_DEV；口径由 Nacos CURATED_MODELS 控制（src/app/api/models/curated-models.ts）',
    async check(): Promise<ItemResult> {
      // E1 的正面兑现：真打 `GET /api/models?provider=<p>`，断言 hermes profile 的两个
      // proxyProvider 漏斗各自返回期望模型。**打不到就 skip（未检测），绝不冒充 pass。**
      const key = resolveEnvValue('PRISMER_API_KEY_DEV') ?? resolveEnvValue('PRISMER_API_KEY') ?? resolveEnvValue('DEV_JWT');
      if (!key) return { status: 'skip', detail: '无 PRISMER_API_KEY_DEV / PRISMER_API_KEY / DEV_JWT → 网关口径未检测' };
      const missing: string[] = [];
      const seen: string[] = [];
      for (const { provider, model } of EXPECTED_GATEWAY_MODELS) {
        const p = await httpProbe(`${CLOUD_DEV_URL}/api/models?provider=${provider}`, {
          headers: { Authorization: `Bearer ${key}` },
          timeoutMs: 8_000,
        });
        if (!p.ok) return { status: 'skip', detail: `GET /api/models?provider=${provider} → ${p.status ?? p.error}（未检测）` };
        try {
          const j = JSON.parse(p.body ?? '{}') as { data?: Array<{ id: string }> };
          const ids = (j.data ?? []).map((d) => d.id);
          seen.push(`${provider}=[${ids.join(', ')}]`);
          if (!ids.includes(model)) missing.push(`${provider} 漏斗缺 ${model}`);
        } catch {
          return { status: 'skip', detail: `provider=${provider} 响应非 JSON（未检测）` };
        }
      }
      return missing.length
        ? { status: 'fail', detail: `${missing.join('；')}。实到：${seen.join(' · ')}` }
        : { status: 'pass', detail: `真拉 /api/models：${seen.join(' · ')}` };
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 段 3：密钥 / 配置（**只判在场；不读值、不打印；报缺不报文**）
// ─────────────────────────────────────────────────────────────────────────────

const secretItems: EnvItem[] = [
  {
    id: 'secrets.env-local-required-keys',
    section: 'secrets',
    label: '.env.local 必需 key 在场（值永不读取/打印）',
    strength: 'presence',
    manualOnly: true,
    fixHint:
      '从对应 Nacos namespace 或团队保险箱取值补进 .env.local；`apc env up` 明确不代办凭据（06 §0 原则 2）',
    async check(): Promise<ItemResult> {
      const envLocal = readEnvLocal();
      const missing = REQUIRED_ENV_KEYS.filter(({ key }) => {
        const v = resolveEnvValue(key, envLocal);
        return v === undefined || v === '';
      });
      const hasCred = DEV_CREDENTIAL_KEYS.some((k) => {
        const v = resolveEnvValue(k, envLocal);
        return v !== undefined && v !== '';
      });
      const problems = missing.map((m) => `${m.key}（消费者 ${m.consumer}）`);
      if (!hasCred) problems.push(`本地凭据缺失：${DEV_CREDENTIAL_KEYS.join(' / ')} 一个都没有`);
      const present = REQUIRED_ENV_KEYS.length - missing.length;
      // 诚实边界：本判定只看 `process.env ∪ .env.local`，**不加载 Nacos**（06 §1 的清单锚的是
      // `.env.local`）。Nacos 可能在运行时补上同名键（配置优先级 env > Nacos > defaults），
      // 所以这里的红读作"这台机的 .env.local 缺"，不读作"运行时一定拿不到"。
      const caveat = '（判定范围 = process.env ∪ .env.local，不加载 Nacos；Nacos 可能在运行时补上）';
      return problems.length
        ? {
            status: 'fail',
            detail: `缺 ${problems.length} 项：${problems.join('；')}（在场 ${present}/${REQUIRED_ENV_KEYS.length}）${caveat}`,
          }
        : { status: 'pass', detail: `${present}/${REQUIRED_ENV_KEYS.length} 必需键在场 + 本地凭据在场（未读取任何值）${caveat}` };
    },
  },
  {
    id: 'secrets.ota-ui-signing-key',
    section: 'secrets',
    label: 'OTA 签名私钥可从**托管源**解出（M3 硬前置）',
    strength: 'presence',
    manualOnly: true,
    fixHint:
      `优先灌 Nacos（托管层）：\`npx tsx scripts/ops/nacos-add-ota-signing-key.ts --apply\`；` +
      `本地兜底才是把 ota-ui-private.pem 放到 ${OTA_SIGNING_KEY}（私钥不进仓库、不代生成）`,
    async check(): Promise<ItemResult> {
      // desktop205 O16-a 之后，`.keys/*.pem` 在位**不再等于**发版能签名——release-ota.sh 置
      // OTA_SIGNING_REQUIRE_MANAGED=1，本地文件那一级会被硬拒。所以本项从"看那个文件在不在"
      // 换成"跑 canonical 解析器，问它发版路径能不能解出来"（同本文件头的纪律：manifest 是对
      // canonical 源的取值器，不是第二份真相）。
      // stdout 会打印密钥本身 ⇒ 显式 >/dev/null，只取 stderr 的来源自报行。
      const appEnv = /^(prod|test|dev)$/.test(process.env.APP_ENV ?? '') ? process.env.APP_ENV! : 'prod';
      const r = await runBash(
        `OTA_SIGNING_REQUIRE_MANAGED=1 APP_ENV=${appEnv} node apps/desktop/scripts/lib/ota-signing-key.cjs --export >/dev/null`,
        25_000,
      );
      const source = r.stderr.split('\n').find((l) => l.includes('signing key source'))?.trim();
      if (r.ok) return { status: 'pass', detail: `发版路径可解（APP_ENV=${appEnv}）：${source ?? '来源未自报'}` };
      // 托管源不通时，本地兜底是否在位决定了严重程度：本地有 ⇒ 本机能构建、发版会红（warn）；
      // 本地也没有 ⇒ 什么都签不了（fail）。
      const f = path.join(REPO_ROOT, OTA_SIGNING_KEY);
      const localOk = existsSync(f) && statSync(f).size > 0;
      return localOk
        ? { status: 'warn', detail: `托管源（env / Nacos@${appEnv}）解不出，仅本地 ${OTA_SIGNING_KEY} 在位 ⇒ 本机可构建，但发版路径会拒收` }
        : { status: 'fail', detail: `托管源（env / Nacos@${appEnv}）解不出，本地 ${OTA_SIGNING_KEY} 也不在位 ⇒ 无法签名` };
    },
  },
  {
    id: 'secrets.test-identity-mintable',
    section: 'secrets',
    label: '测试身份可铸（默认测试账号在库 ∧ 能签出当下有效 JWT）',
    strength: 'presence',
    manualOnly: true,
    fixHint:
      `见 detail 里的具体缺口：缺账号 → 按 fix 指的 seed 路径补（e2e-playwright/fixtures/auth.ts::seedUser 幂等注册）；` +
      `缺 JWT_SECRET → 从 Nacos / 团队保险箱补进 .env.local（**报缺不报文**）。` +
      `自查：\`npx tsx scripts/test203/lib/test-identity.ts --check\``,
    async check(): Promise<ItemResult> {
      // 为什么这是 manifest 的一段而不是便利项（06 §1.1，2026-07-28 实证）：
      // 18 个文件里焊死过 5 个真 JWT，全部过期，且**无一在 baseline.json 里** ⇒ 过期后
      // 每跑一次都报新回归，把 `--diff` 的回归判据持续污染。门依赖了一个既不在清单里、
      // 也不被 doctor 检查、还会自己过期的东西 —— §0「环境即清单」在那里被绕过了。
      //
      // 本项**只回答"能不能铸出来"**：不读值、不打印、不写文件、不进 fingerprint。
      // 铸出来的 token 在 checkTestIdentityMintable() 内部用完即弃，不回传。
      const { checkTestIdentityMintable } = await import('../../../scripts/test203/lib/test-identity');
      const r = await checkTestIdentityMintable();
      // fixHint 是 item 上的静态串（doctor.ts::runItem 只取那一份），所以把**具体**缺口
      // 折进 detail —— 否则「缺账号」和「缺密钥」会给出同一句话。
      return r.ok ? { status: 'pass', detail: r.detail } : { status: 'fail', detail: `${r.detail}；fix: ${r.fixHint}` };
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 段 4：工程态
// ─────────────────────────────────────────────────────────────────────────────

export interface LockConsistency {
  ok: boolean;
  total: number;
  missing: string[];
  mismatched: string[];
}

/**
 * E5：**一致性**，不是「两个 fileExists」。
 * 对 package.json 的每个直接依赖：lockfile 记的版本 ⇄ `node_modules/<pkg>/package.json`
 * 实装版本 **逐包比对**。stale node_modules（切分支后没 npm ci）会在这里红。
 */
export function checkLockConsistency(repoRoot = REPO_ROOT): LockConsistency {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const lock = JSON.parse(readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8')) as {
    packages?: Record<string, { version?: string; link?: boolean }>;
  };
  const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const name of names) {
    const lockEntry = lock.packages?.[`node_modules/${name}`];
    let installed: string | undefined;
    try {
      installed = (
        JSON.parse(readFileSync(path.join(repoRoot, 'node_modules', name, 'package.json'), 'utf8')) as {
          version?: string;
        }
      ).version;
    } catch {
      installed = undefined;
    }
    if (!installed) {
      missing.push(name);
      continue;
    }
    if (lockEntry?.version && !lockEntry.link && lockEntry.version !== installed)
      mismatched.push(`${name} lock=${lockEntry.version} installed=${installed}`);
  }
  return { ok: missing.length === 0 && mismatched.length === 0, total: names.length, missing, mismatched };
}

export interface VersionAlignment {
  ok: boolean;
  version: string;
  mismatched: string[];
  unreadable: string[];
}

export function checkVersionAlignment(repoRoot = REPO_ROOT): VersionAlignment {
  const version = readFileSync(path.join(repoRoot, 'VERSION'), 'utf8').trim();
  const mismatched: string[] = [];
  const unreadable: string[] = [];
  for (const rel of VERSION_FILES) {
    try {
      const j = JSON.parse(readFileSync(path.join(repoRoot, rel), 'utf8')) as { version?: string };
      if (j.version !== version) mismatched.push(`${rel}=${j.version ?? 'n/a'}`);
    } catch {
      unreadable.push(rel);
    }
  }
  return { ok: mismatched.length === 0 && unreadable.length === 0, version, mismatched, unreadable };
}

const projectItems: EnvItem[] = [
  {
    id: 'project.node-modules-lockfile',
    section: 'project',
    label: 'node_modules 与 lockfile 一致（逐包版本比对，非存在性）',
    strength: 'consistency',
    fixHint: 'npm ci',
    async check(): Promise<ItemResult> {
      const c = checkLockConsistency();
      if (c.ok) return { status: 'pass', detail: `${c.total} 个直接依赖逐包版本与 package-lock.json 一致` };
      const parts: string[] = [];
      if (c.missing.length) parts.push(`未安装 ${c.missing.length}（${c.missing.slice(0, 5).join(', ')}…）`);
      if (c.mismatched.length) parts.push(`版本不符 ${c.mismatched.length}（${c.mismatched.slice(0, 5).join('; ')}…）`);
      return { status: 'fail', detail: `${c.total} 个直接依赖中：${parts.join('；')}` };
    },
  },
  {
    id: 'project.prisma-clients',
    section: 'project',
    label: '双 Prisma client 已生成（SQLite default + MySQL generated）',
    strength: 'presence',
    fixHint: 'npm run prisma:generate:all',
    async check(): Promise<ItemResult> {
      const targets = [
        { rel: 'node_modules/.prisma/client', what: 'default(SQLite) client' },
        { rel: 'prisma/generated/mysql', what: 'MySQL client' },
      ];
      const missing = targets.filter((t) => !existsSync(path.join(REPO_ROOT, t.rel)));
      return missing.length
        ? { status: 'fail', detail: `缺 ${missing.map((m) => `${m.what}（${m.rel}）`).join('、')}` }
        : { status: 'pass', detail: targets.map((t) => t.rel).join(' + ') };
    },
  },
  {
    id: 'project.mysql-migrations-pending',
    section: 'project',
    label: '本地迁移无 pending（db:migrate:status 真跑）',
    strength: 'consistency',
    fixHint: 'npm run db:migrate',
    async check(): Promise<ItemResult> {
      // `cmd_status` 在 modified>0 时 return 1（db-migrate.sh:158），所以**不能**拿退出码
      // 当「没跑成」——摘要行照样在 stdout 里。判据取摘要行本身。
      const r = await runBash('./scripts/db-migrate.sh status', 180_000);
      const text = `${r.stdout}\n${r.stderr}`;
      const summary =
        /applied=(\d+)\s+pending=(\d+)\s+renamed=(\d+)\s+modified=(\d+)\s+conflicts=(\d+)/.exec(text);
      if (!summary)
        return { status: 'skip', detail: `db-migrate.sh status 无摘要行（未检测）：${r.error ?? text.slice(-300)}` };
      const [, appliedText, pendingText, , modifiedText, conflictsText] = summary;
      const [applied, pending, modified, conflicts] = [appliedText, pendingText, modifiedText, conflictsText].map(Number);
      if (modified > 0)
        return {
          status: 'fail',
          detail: `${modified} 条已应用迁移被改（checksum 漂移）· applied=${applied} pending=${pending} —— 禁止改已应用迁移，写新迁移修`,
        };
      if (conflicts > 0)
        return {
          status: 'fail',
          detail: `${conflicts} 条 migration number conflict · applied=${applied} pending=${pending} —— 禁止复用编号或改写已重命名迁移`,
        };
      return pending === 0
        ? { status: 'pass', detail: `applied=${applied} pending=0 modified=0 conflicts=0` }
        : { status: 'fail', detail: `${pending} 条 pending migration（applied=${applied}）` };
    },
  },
  {
    id: 'project.version-alignment',
    section: 'project',
    label: '/VERSION 与各版本文件对齐（唯一版本真相源）',
    strength: 'consistency',
    fixHint: 'sdk/build/version.sh --scope all <X.Y.Z>',
    async check(): Promise<ItemResult> {
      const v = checkVersionAlignment();
      if (v.ok) return { status: 'pass', detail: `/VERSION=${v.version}，${VERSION_FILES.length} 个版本文件全部对齐` };
      const parts: string[] = [];
      if (v.mismatched.length) parts.push(`不一致：${v.mismatched.join(', ')}`);
      if (v.unreadable.length) parts.push(`读不到：${v.unreadable.join(', ')}`);
      return { status: 'fail', detail: `/VERSION=${v.version}；${parts.join('；')}` };
    },
  },
  {
    id: 'project.claude-config-dir',
    section: 'project',
    label: 'CLAUDE_CONFIG_DIR 隔离目录在位（D2）',
    strength: 'presence',
    fixHint: `mkdir -p ${isolatedClaudeConfigDir()}   # spawned Claude Code 的 hermetic config home`,
    async check(): Promise<ItemResult> {
      const dir = isolatedClaudeConfigDir();
      if (!existsSync(dir)) return { status: 'fail', detail: `${dir} 不存在（隔离目录未建）` };
      if (!statSync(dir).isDirectory()) return { status: 'fail', detail: `${dir} 存在但不是目录` };
      return { status: 'pass', detail: `${dir} 在位` };
    },
  },
  {
    id: 'project.bare-repo-mirror',
    section: 'project',
    label: `bare-repo 替身在位（${BARE_MIRROR}；release-tag 的本机 push 边界）`,
    strength: 'consistency',
    fixHint: `git init --bare ${BARE_MIRROR}   # 或 apc env up 幂等建`,
    async check(): Promise<ItemResult> {
      const dir = path.join(REPO_ROOT, BARE_MIRROR);
      if (!existsSync(dir)) return { status: 'fail', detail: `${BARE_MIRROR} 不存在` };
      // 目录在 ≠ 是个 bare repo：问 git 本人。
      const r = await run('git', ['-C', dir, 'rev-parse', '--is-bare-repository'], 10_000);
      if (!r.ok) return { status: 'fail', detail: `${BARE_MIRROR} 不是 git 仓库：${r.error}` };
      return r.stdout.trim() === 'true'
        ? { status: 'pass', detail: `${BARE_MIRROR} 是 bare repo（git rev-parse 确认）` }
        : { status: 'fail', detail: `${BARE_MIRROR} 存在但 is-bare-repository=${r.stdout.trim()}` };
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────

/** 四段清单（顺序即输出顺序）。 */
export const ENV_MANIFEST: EnvItem[] = [...infraItems, ...toolchainItems, ...secretItems, ...projectItems];

export function itemsBySection(section: EnvItem['section']): EnvItem[] {
  return ENV_MANIFEST.filter((i) => i.section === section);
}

export function findItem(id: string): EnvItem | undefined {
  return ENV_MANIFEST.find((i) => i.id === id);
}
