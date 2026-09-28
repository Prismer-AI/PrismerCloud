/**
 * probes.ts — **真探针**（协议级，非端口探活）。
 *
 * doc 13 的 E2 判词：上一轮 mysql:3307 / redis:6380 / Nacos 全部走 `tcpProbe` 端口探活
 * ——**wedged 服务会假绿**（端口 accept、协议不应答）。本文件把三条全部提到协议级：
 *
 *   MySQL  → mysql2 真握手 + `SELECT VERSION()`（会话真建立、真返回行）
 *   Redis  → ioredis RESP `PING` → 必须真收到 `PONG`
 *   Nacos  → HTTP `GET /nacos/v1/console/health/readiness`（CLAUDE.md：Nacos 2.x
 *            必须用 HTTP API，不能用 npm 包）
 *   kind   → `kubectl --context kind-<cluster> get nodes -o json` 打 **API server**，
 *            不是 `kind get clusters` 的本地登记（后者容器死了也照样列出来）
 *
 * 取证纪律沿 `scripts/test204/lib/errors.ts`：子进程失败一律 `errText()` 带 stdout+stderr+
 * 退出码，禁「取 message 首行」（那是在销毁证据）。
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { errText } from '../../../scripts/test204/lib/errors';

const exec = promisify(execFile);

/** 仓库根：sdk/apc/env → ../../.. */
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// ─── 子进程 ────────────────────────────────────────────────────────────────

export interface ExecOutcome {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** 失败时的完整取证串（errText：stdout+stderr+退出码/信号）。 */
  error?: string;
}

export async function run(cmd: string, args: string[], timeoutMs = 20_000): Promise<ExecOutcome> {
  try {
    const { stdout, stderr } = await exec(cmd, args, { timeout: timeoutMs, cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (e) {
    // 退出码非 0 **不等于** 没有输出。`db-migrate.sh status` 就是 modified>0 时 return 1
    // 而摘要行照样在 stdout 里 —— 丢掉它就等于销毁证据（errors.ts 文件头的同一条教训）。
    const err = e as { stdout?: string | Buffer; stderr?: string | Buffer };
    const asText = (v: string | Buffer | undefined) => (v == null ? '' : (typeof v === 'string' ? v : v.toString('utf8')).trim());
    return { ok: false, stdout: asText(err.stdout), stderr: asText(err.stderr), error: errText(e) };
  }
}

export async function runBash(script: string, timeoutMs = 120_000): Promise<ExecOutcome> {
  return run('bash', ['-lc', script], timeoutMs);
}

/** `which <bin>` —— 命令是否在 PATH 上（up 的前置判定也用它）。 */
export async function which(bin: string): Promise<string | null> {
  const r = await run('which', [bin], 5_000);
  return r.ok && r.stdout ? r.stdout.split('\n')[0]! : null;
}

/** 取 `<bin> --version` 的第一个 semver（很多 CLI 会带前后缀：`codex-cli 0.145.0`）。 */
export async function binaryVersion(bin: string, args = ['--version']): Promise<{ raw: string; semver: string | null } | null> {
  const found = await which(bin);
  if (!found) return null;
  const r = await run(bin, args, 30_000);
  const raw = (r.stdout || r.stderr || r.error || '').trim();
  if (!raw) return null;
  const m = /\d+\.\d+\.\d+/.exec(raw);
  return { raw: raw.split('\n')[0]!.trim(), semver: m ? m[0] : null };
}

// ─── stdout 写出（**必须等 flush**）──────────────────────────────────────

/**
 * 往 stdout 写并**等真正落盘/落管道**，然后才允许 `process.exit()`。
 *
 * 为什么不能直接 `process.stdout.write(json); process.exit(code)`：stdout 接管道时是
 * **异步**的，`process.exit` 会把还在缓冲区里的尾巴一起带走 —— 消费者
 * （`scripts/test203/run.ts` 的 `spawnSync` + `JSON.parse`）拿到的是**截断的 JSON**，
 * 解析失败 → 它静默回退内置检查，而 doctor 这边退出码还是对的，看起来一切正常。
 * 实测就是这么翻的车（截断在第 7441 字节）。
 */
export function writeStdout(text: string): Promise<void> {
  // write 的 callback 在数据**真的交给底层资源之后**才触发；返回值 true 只说明没超
  // highWaterMark，不代表已 flush。所以判据取 callback。
  return new Promise((resolve) => process.stdout.write(text, () => resolve()));
}

// ─── .env.local（只读键，值不外传）────────────────────────────────────────

const ENV_LOCAL = path.join(REPO_ROOT, '.env.local');

/** 解析 `.env.local` 为 Map。**调用方只许用键名/连接串，禁止把值打进任何输出。** */
export function readEnvLocal(file = ENV_LOCAL): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out.set(m[1]!, v);
  }
  return out;
}

/** env > .env.local（doctor 是只读的，不改 process.env）。 */
export function resolveEnvValue(key: string, envLocal = readEnvLocal()): string | undefined {
  return process.env[key] ?? envLocal.get(key);
}

/** URL 里的口令永远不许进输出。 */
export function redactUrl(url: string): string {
  return url.replace(/\/\/([^:/@]+):([^@]*)@/, '//$1:***@');
}

// ─── MySQL（协议级）────────────────────────────────────────────────────────

export interface MysqlProbe {
  ok: boolean;
  version?: string;
  /** `schema_migrations` 账本行数（表不存在 = null）。 */
  ledgerRows?: number | null;
  /** 账本里最后一条 filename（用于 fingerprint 的 schema revision）。 */
  ledgerHead?: string | null;
  error?: string;
}

/**
 * 真连 MySQL 跑查询。**不是 tcp connect** —— 握手 + auth + `SELECT VERSION()` 全走完，
 * wedged 的 mysqld（端口 accept 但不应答）会在这里红。
 *
 * 本机账本表 = `schema_migrations`（`scripts/db-migrate.sh:81`）；`_migrations` 是远端
 * sync 的账本（`scripts/ops/sync-test-migrations.ts`），doctor 在本机查前者（06 §1）。
 */
export async function mysqlProbe(url: string, timeoutMs = 8_000): Promise<MysqlProbe> {
  type Conn = { query: (sql: string) => Promise<unknown[]>; end: () => Promise<void> };
  let conn: Conn | null = null;
  try {
    const mysql = (await import('mysql2/promise')) as typeof import('mysql2/promise');
    conn = (await mysql.createConnection({ uri: url, connectTimeout: timeoutMs })) as unknown as Conn;
    const [vRows] = (await conn!.query('SELECT VERSION() AS v')) as unknown as [Array<{ v: string }>];
    const version = vRows?.[0]?.v ?? 'unknown';

    let ledgerRows: number | null = null;
    let ledgerHead: string | null = null;
    try {
      const [cRows] = (await conn!.query(
        'SELECT COUNT(*) AS n FROM schema_migrations',
      )) as unknown as [Array<{ n: number }>];
      ledgerRows = Number(cRows?.[0]?.n ?? 0);
      const [hRows] = (await conn!.query(
        'SELECT filename FROM schema_migrations ORDER BY applied_at DESC, filename DESC LIMIT 1',
      )) as unknown as [Array<{ filename: string }>];
      ledgerHead = hRows?.[0]?.filename ?? null;
    } catch {
      ledgerRows = null; // 表不存在 → 账本未建（需要 db:migrate:baseline）
    }
    return { ok: true, version, ledgerRows, ledgerHead };
  } catch (e) {
    return { ok: false, error: errText(e) };
  } finally {
    try {
      await conn?.end();
    } catch {
      /* 关连接失败无所谓：探针结论已经拿到了 */
    }
  }
}

// ─── Redis（协议级）────────────────────────────────────────────────────────

export interface RedisProbe {
  ok: boolean;
  pong?: string;
  serverVersion?: string;
  error?: string;
}

/** RESP `PING` 必须真收到 `PONG`（端口 accept 不算数）。 */
export async function redisProbe(url: string, timeoutMs = 5_000): Promise<RedisProbe> {
  const { default: IORedis } = (await import('ioredis')) as unknown as {
    default: new (url: string, opts: Record<string, unknown>) => {
      connect: () => Promise<void>;
      ping: () => Promise<string>;
      info: (s: string) => Promise<string>;
      quit: () => Promise<unknown>;
      disconnect: () => void;
      on: (ev: string, fn: (e: unknown) => void) => void;
    };
  };
  const client = new IORedis(url, {
    lazyConnect: true,
    connectTimeout: timeoutMs,
    commandTimeout: timeoutMs,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    enableOfflineQueue: false,
  });
  client.on('error', () => {
    /* 错误通过下面的 await 抛出；这里只防 unhandled 'error' 事件把进程打死 */
  });
  try {
    // lazyConnect + enableOfflineQueue:false ⇒ 必须先显式建连，否则 PING 会被
    // "Stream isn't writeable" 直接拒掉（那是探针自己的 bug，会把健康的 redis 判红）。
    await client.connect();
    const pong = await client.ping();
    let serverVersion: string | undefined;
    try {
      const info = await client.info('server');
      serverVersion = /redis_version:([^\r\n]+)/.exec(info)?.[1];
    } catch {
      /* INFO 失败不改判：PING 已经证明协议活着 */
    }
    if (pong !== 'PONG') return { ok: false, error: `PING 返回 ${JSON.stringify(pong)}，不是 PONG` };
    return { ok: true, pong, serverVersion };
  } catch (e) {
    return { ok: false, error: errText(e) };
  } finally {
    try {
      await client.quit();
    } catch {
      client.disconnect();
    }
  }
}

// ─── HTTP ──────────────────────────────────────────────────────────────────

export interface HttpProbe {
  ok: boolean;
  status?: number;
  body?: string;
  error?: string;
}

export async function httpProbe(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number; maxBody?: number } = {},
): Promise<HttpProbe> {
  try {
    const r = await fetch(url, {
      headers: opts.headers,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8_000),
    });
    const body = (await r.text()).slice(0, opts.maxBody ?? 4_000);
    return { ok: r.ok, status: r.status, body };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

/**
 * Nacos 健康（CLAUDE.md：Nacos 2.x **必须用 HTTP API**）。
 * `/nacos/v1/console/health/readiness` 是 Nacos 官方就绪端点，返回 200 + `OK`。
 */
export function nacosBaseUrl(envLocal = readEnvLocal()): string {
  const addr =
    resolveEnvValue('CONFIG_CENTER_IP', envLocal) ??
    resolveEnvValue('NACOS_SERVER_ADDR', envLocal) ??
    // src/lib/nacos-config.ts:57 的同一默认值。
    'nacos.docbrew.cn';
  const base = addr.startsWith('http') ? addr : `https://${addr}`;
  return base.replace(/\/$/, '');
}

export async function nacosHealth(base = nacosBaseUrl(), timeoutMs = 10_000): Promise<HttpProbe> {
  return httpProbe(`${base}/nacos/v1/console/health/readiness`, { timeoutMs });
}

// ─── kind / kubectl（打 API server，不是本地登记）───────────────────────────

export interface KindProbe {
  ok: boolean;
  clusterListed: boolean;
  nodesReady?: number;
  nodesTotal?: number;
  error?: string;
}

export async function kindProbe(cluster: string, timeoutMs = 20_000): Promise<KindProbe> {
  const list = await run('kind', ['get', 'clusters'], 15_000);
  const clusterListed = list.ok && list.stdout.split('\n').some((l) => l.trim() === cluster);
  if (!clusterListed) {
    return { ok: false, clusterListed: false, error: list.ok ? `kind get clusters 无 ${cluster}` : list.error };
  }
  // 打真 API server：本地登记还在但容器已死时，这一步才会红。
  const nodes = await run(
    'kubectl',
    ['--context', `kind-${cluster}`, 'get', 'nodes', '-o', 'json', '--request-timeout=15s'],
    timeoutMs,
  );
  if (!nodes.ok) return { ok: false, clusterListed: true, error: nodes.error };
  try {
    const parsed = JSON.parse(nodes.stdout) as {
      items: Array<{ status?: { conditions?: Array<{ type: string; status: string }> } }>;
    };
    const total = parsed.items.length;
    const ready = parsed.items.filter((n) =>
      (n.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True'),
    ).length;
    return { ok: total > 0 && ready === total, clusterListed: true, nodesReady: ready, nodesTotal: total };
  } catch (e) {
    return { ok: false, clusterListed: true, error: errText(e) };
  }
}
