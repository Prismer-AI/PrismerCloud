---
name: debug-log
description: 查看 Prismer Evolution 插件的调试日志，诊断 hook 运行状态
user-invocable: true
---

查看 Prismer 插件的结构化调试日志。每条日志包含时间戳、级别、hook 名称和上下文。

## 查看最近日志

```bash
CACHE="${CLAUDE_PLUGIN_DATA:-$(dirname "$0")/../../.cache}"
LOG="$CACHE/prismer-debug.log"
if [ -f "$LOG" ]; then
  echo "=== Prismer Debug Log (last 30 entries) ==="
  tail -30 "$LOG" | while IFS= read -r line; do
    # 格式化 JSON 为可读输出
    echo "$line" | node -e "
      const line = require('fs').readFileSync(0,'utf8').trim();
      try {
        const j = JSON.parse(line);
        const lvl = {debug:'D',info:'I',warn:'W',error:'E'}[j.lvl]||'?';
        const {ts,lvl:_,hook,msg,...ctx} = j;
        const extra = Object.keys(ctx).length ? ' ' + JSON.stringify(ctx) : '';
        console.log(\`[\${ts.slice(11,19)}] \${lvl} [\${hook}] \${msg}\${extra}\`);
      } catch { console.log(line); }
    " 2>/dev/null || echo "$line"
  done
else
  echo "No log file found at: $LOG"
  echo "Logs are created after the first hook runs."
  echo "Set PRISMER_LOG_LEVEL=debug for verbose output."
fi
```

## 日志级别

通过环境变量 `PRISMER_LOG_LEVEL` 控制：
- `debug` — 所有操作（dev mode 默认）
- `info` — 关键操作（生产默认）
- `warn` — 仅告警和错误
- `error` — 仅错误

## 常见问题诊断

| 日志关键词 | 含义 | 解决 |
|-----------|------|------|
| `sync-pull-failed timeout:true` | 进化网络同步超时 | 检查网络连接或 API 状态 |
| `sync-pull-failed error:...` | API 返回错误 | 检查 API Key 是否有效 |
| `memory-pull-failed` | 记忆加载失败 | 检查 API Key 权限 |
| `evolution-query timeout:true` | 进化查询超时（stuck detection） | 正常降级，不影响工作 |
| `cache-save-failed` | Web 缓存保存失败 | 非关键，自动跳过 |
