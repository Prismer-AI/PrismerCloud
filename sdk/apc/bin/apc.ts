#!/usr/bin/env npx tsx
/**
 * apc.ts — `apc` CLI 入口（apc/00 §2.45：CLI 与专项同名；**不进** `prismer` runtime CLI、
 * 不进 `@prismer/sdk` —— 开发工具不与产品耦合）。
 *
 * M1-a 只 wire `env` 一族：
 *
 *   apc env doctor       只读判定 · stdout 纯 JSON · exit 0 / 78(env_blocked)
 *   apc env up           幂等修复 · exit 0 / 1
 *   apc env fingerprint  环境指纹 · exit 0
 *
 * 后续动词（test / release / ack / platform-install）落 `sdk/apc/cli/`，在 M1-b 及之后接进来。
 */
const USAGE = `apc — Auto Prismer Cloud 开发工具链

用法：
  apc env doctor                 只读跑完 env-manifest 四段，逐项 pass/fail + fix-hint
                                 stdout = 结构化 JSON（消费者契约）· stderr = 人可读摘要
                                 exit 0 全绿 · 78 env_blocked（环境故障域，非 SUT 红）
  apc env up [--dry-run] [--only=a,b]
                                 幂等拉起可自动化项（凭据/签名 key 不代办，只出 fix-hint）
                                 exit 0 ok · 1 有步骤失败
  apc env fingerprint            环境指纹（机器等价性证明）· exit 0

  apc test [--tier=T0,T1,...] [--diff] [--baseline] [--json] [--list]
                                 全层测试编排（包装 scripts/test203/run.ts，02 §2 R1）
                                 退出码原样透传：0 绿 · 1 SUT 红/回归 · 2 用法错
                                 · 78 env_blocked（环境故障域，非 SUT 红）

  apc skills inject-ack <bundleDir...> [--json]
                                 注入层1 调用回执纪律块到 SKILL.md 尾部（04 §2）
                                 幂等（重复跑零 diff）· 拒绝 built-in-skills 目录
                                 exit 0 ok · 1 有失败 · 2 用法错
  apc skills ack-receipts <taskId> [--expect a,b,c] [--json]
                                 读 im_task_logs 回执行判定 skill 是否真被调度
                                 exit 0 ok · 1 缺失/请求失败 · 2 用法错
  apc skills platform-install <bundleDir...> --workspace <id> [--agent <id>]... [--json]
                                 catalog 私域导入 + 装到平台方 workspace 的 agent（00 §2.4）
                                 exit 0 ok · 1 有失败 · 2 用法错

  apc release preflight [--tier=TD] [--json]
                                 发版硬前置只读门（tier 全绿 + 版本对齐 + prisma regen，01 §2）
                                 exit 0 green · 3 staged · 1 blocked
  apc release db-config-sync [--ref <dump>] [--cur <dump>] [--json]
                                 迁移 dry-run（真 sync-test-migrations.ts）+ Nacos key-diff（治 R3）
                                 exit 0 无差异 · 3 有 pending/缺 key · 1 blocked
  apc release tag [--channel k8s|desktop] [--target test|prod] [--approved <tok>] [--json]
                                 算 tag + tier 硬前置 + 审批门 + push bare mirror（prod 人闸拒）
                                 exit 0 pushed · 3 待审批 · 1 blocked
  apc release ota-promote [--env dev|test|prod] [--json]
                                 双通道 OTA（真 runtime-ota.ts；桌面 feed ⬜，治 R4）
                                 exit 0 green · 1 blocked
  apc release rollback [--ledger <path>] [--mirror <bare>] [--approved <tok>] [--json]
                                 真回滚：release 账本回退 + 版本指针回退
                                 exit 0 done · 3 待审批 · 1 无上一好版本

文档：docs/apc/06-env-scaffold.md · docs/apc/02-test-rebuild.md · docs/apc/04-mvp-stages.md
`;

async function main(): Promise<number> {
  const [group, verb, ...rest] = process.argv.slice(2);

  if (!group || group === '--help' || group === '-h' || group === 'help') {
    process.stdout.write(USAGE);
    return group ? 0 : 2;
  }

  // `apc test` 是包装层（02 §2 R1）：整串参数原样交给 scripts/test203/run.ts。
  if (group === 'test') {
    const rest2 = verb === undefined ? [] : [verb, ...rest];
    return (await import('../cli/test-run')).main(rest2);
  }

  // `apc skills *`（M1-c ack 基座 + M1-e platform-install，04 §2 / 00 §2.4）。
  if (group === 'skills') {
    switch (verb) {
      case 'inject-ack':
        return (await import('../cli/inject-ack')).main(rest);
      case 'ack-receipts':
        return (await import('../cli/ack-receipts')).main(rest);
      case 'platform-install':
        return (await import('../cli/platform-install')).main(rest);
      default:
        process.stderr.write(`apc skills: 未知动词 ${verb ?? '(缺失)'}\n\n${USAGE}`);
        return 2;
    }
  }

  // `apc release *`（M3-a 发版控制面 5 verb，01 §2）。
  if (group === 'release') {
    switch (verb) {
      case 'preflight':
        return (await import('../cli/release-preflight')).main(rest);
      case 'db-config-sync':
        return (await import('../cli/release-db-config-sync')).main(rest);
      case 'tag':
        return (await import('../cli/release-tag')).main(rest);
      case 'ota-promote':
        return (await import('../cli/release-ota-promote')).main(rest);
      case 'rollback':
        return (await import('../cli/release-rollback')).main(rest);
      default:
        process.stderr.write(`apc release: 未知动词 ${verb ?? '(缺失)'}\n\n${USAGE}`);
        return 2;
    }
  }

  if (group !== 'env') {
    process.stderr.write(`apc: 未知命令组 ${group}\n\n${USAGE}`);
    return 2;
  }

  switch (verb) {
    case 'doctor':
      return (await import('../env/doctor')).main();
    case 'up':
      return (await import('../env/up')).main(rest);
    case 'fingerprint':
      return (await import('../env/fingerprint')).main();
    default:
      process.stderr.write(`apc env: 未知动词 ${verb ?? '(缺失)'}\n\n${USAGE}`);
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`apc: 崩溃 ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(1);
  },
);
