#!/usr/bin/env node
/**
 * Hook 隔离测试工具 — 模拟 Claude Code 调用单个 hook
 *
 * 用法:
 *   node scripts/test-hook.mjs session-start.mjs              # 模拟 startup 事件
 *   node scripts/test-hook.mjs session-start.mjs --event resume  # 指定事件类型
 *   node scripts/test-hook.mjs pre-bash-suggest.mjs --stdin '{"tool_input":{"command":"npm run build"}}'
 *   echo '{"tool_name":"Bash","tool_input":{"command":"tsc"}}' | node scripts/test-hook.mjs post-bash-journal.mjs
 *
 * 选项:
 *   --event <type>    Hook 事件类型 (默认: startup)
 *   --stdin <json>    手动传入 stdin JSON (否则从管道读)
 *   --env KEY=VAL     追加环境变量 (可多次使用)
 *   --verbose         显示完整环境变量
 *
 * 输出:
 *   [STDOUT] ... hook 的标准输出 (注入到 Claude 上下文的内容)
 *   [STDERR] ... hook 的调试日志
 *   [Exit: N] 进程退出码
 *   [Time: NNms] 执行耗时
 */

import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, readdirSync, statSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

// --- Parse args ---
const scriptName = args.find(a => a.endsWith('.mjs'));
if (!scriptName) {
  console.error('Usage: node scripts/test-hook.mjs <hook-script.mjs> [--event <type>] [--stdin <json>]');
  process.exit(1);
}

const eventIdx = args.indexOf('--event');
const event = eventIdx >= 0 ? args[eventIdx + 1] : 'startup';

const stdinIdx = args.indexOf('--stdin');
const manualStdin = stdinIdx >= 0 ? args[stdinIdx + 1] : null;

const verbose = args.includes('--verbose');

// Parse --env KEY=VAL pairs
const extraEnv = {};
let i = 0;
while (i < args.length) {
  if (args[i] === '--env' && args[i + 1]) {
    const [k, ...v] = args[i + 1].split('=');
    extraEnv[k] = v.join('=');
    i += 2;
  } else {
    i++;
  }
}

// --- Setup ---
const devCache = resolve(__dirname, '..', '.dev-cache');
mkdirSync(devCache, { recursive: true });

const env = {
  ...process.env,
  CLAUDE_PLUGIN_DATA: devCache,
  PRISMER_LOG_LEVEL: process.env.PRISMER_LOG_LEVEL || 'debug',
  ...extraEnv,
};

if (verbose) {
  console.log('[ENV]', JSON.stringify({
    CLAUDE_PLUGIN_DATA: env.CLAUDE_PLUGIN_DATA,
    PRISMER_API_KEY: env.PRISMER_API_KEY ? '***set***' : 'unset',
    PRISMER_BASE_URL: env.PRISMER_BASE_URL || 'default',
    PRISMER_LOG_LEVEL: env.PRISMER_LOG_LEVEL,
    ...extraEnv,
  }, null, 2));
}

const scriptPath = resolve(__dirname, scriptName);
const startTime = Date.now();

console.log(`[Test] Running: ${scriptName} (event: ${event})`);
console.log('─'.repeat(60));

const child = spawn('node', [scriptPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });

// Feed stdin
const stdinData = manualStdin || JSON.stringify({ type: event, event: event });

if (!process.stdin.isTTY && !manualStdin) {
  // Pipe from parent stdin
  process.stdin.pipe(child.stdin);
} else {
  child.stdin.write(stdinData);
  child.stdin.end();
}

// Capture output
child.stdout.on('data', d => {
  for (const line of d.toString().split('\n').filter(Boolean)) {
    console.log(`\x1b[32m[STDOUT]\x1b[0m ${line}`);
  }
});

child.stderr.on('data', d => {
  for (const line of d.toString().split('\n').filter(Boolean)) {
    console.log(`\x1b[33m[STDERR]\x1b[0m ${line}`);
  }
});

child.on('close', code => {
  console.log('─'.repeat(60));
  console.log(`[Exit: ${code}] [Time: ${Date.now() - startTime}ms]`);

  // Show generated files
  try {
    const files = readdirSync(devCache).filter(f => !f.startsWith('.'));
    if (files.length > 0) {
      console.log(`[Cache files] ${devCache}/`);
      for (const f of files) {
        console.log(`  ${f} (${statSync(resolve(devCache, f)).size} bytes)`);
      }
    }
  } catch {}
});
