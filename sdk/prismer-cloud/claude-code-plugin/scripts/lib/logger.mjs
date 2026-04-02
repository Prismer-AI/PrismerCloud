/**
 * Prismer Plugin — 结构化日志
 *
 * 写到 {CACHE_DIR}/prismer-debug.log，JSON 格式，自动轮转。
 *
 * 用法:
 *   import { createLogger } from './lib/logger.mjs';
 *   const log = createLogger('session-start');
 *   log.info('sync-pull', { scope: 'myapp', genes: 5 });
 *   log.warn('sync-timeout', { latency: 2100 });
 *   log.error('sync-failed', { error: 'ECONNREFUSED' });
 *
 * 日志级别 (PRISMER_LOG_LEVEL):
 *   debug < info < warn < error
 *   默认: info (生产), debug (dev mode 自动设置)
 *
 * 查看日志:
 *   tail -f .dev-cache/prismer-debug.log   # dev mode
 *   /prismer:debug-log                     # Claude Code skill
 */

import { appendFileSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = process.env.CLAUDE_PLUGIN_DATA || join(__dirname, '..', '..', '.cache');
const LOG_FILE = join(CACHE_DIR, 'prismer-debug.log');
const MAX_LOG_SIZE = 100_000; // 100KB, truncate to last 50KB
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL = LEVELS[process.env.PRISMER_LOG_LEVEL || 'info'] ?? LEVELS.info;

// Ensure cache dir exists
try { mkdirSync(CACHE_DIR, { recursive: true }); } catch {}

/**
 * Create a logger scoped to a hook name.
 * @param {string} hookName - e.g. 'session-start', 'pre-bash-suggest'
 */
export function createLogger(hookName) {
  function log(lvl, msg, ctx = {}) {
    if (LEVELS[lvl] < MIN_LEVEL) return;

    const line = JSON.stringify({
      ts: new Date().toISOString(),
      lvl,
      hook: hookName,
      msg,
      ...ctx,
    });

    try {
      appendFileSync(LOG_FILE, line + '\n');
    } catch {}

    // error 级别同时输出到 stderr（可被 Claude Code 捕获）
    if (lvl === 'error') {
      process.stderr.write(`[Prismer:${hookName}] ${msg}\n`);
    }
  }

  return {
    debug: (msg, ctx) => log('debug', msg, ctx),
    info:  (msg, ctx) => log('info', msg, ctx),
    warn:  (msg, ctx) => log('warn', msg, ctx),
    error: (msg, ctx) => log('error', msg, ctx),
  };
}

/**
 * Rotate log file if it exceeds MAX_LOG_SIZE.
 * Called once per session start (cheap).
 */
export function rotateLogIfNeeded() {
  try {
    const stat = statSync(LOG_FILE);
    if (stat.size > MAX_LOG_SIZE) {
      const content = readFileSync(LOG_FILE, 'utf8');
      writeFileSync(LOG_FILE, content.slice(-Math.floor(MAX_LOG_SIZE / 2)));
    }
  } catch {}
}
