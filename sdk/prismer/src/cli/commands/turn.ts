// `prismer turn run` — 环境内一次性 turn 进程（Gate B+ Task 7 design §2.4）。
//
// 由 cloud 的 EaasSandboxPort exec 包装器在租户容器内调用：
//   node <PRISMER_HOME>/bundle/<ver>/dist/cli.js turn run \
//     --input  <turnDir>/input.json  --output <turnDir>/output.json \
//     --egress-file <turnDir>/egress.json --adapter pi-core --deadline-ms 120000
//
// 契约（勿改，cloud 端口按此判定）：
//   - **stdout 不是数据通道**（引擎日志会污染它）；结果只写 --output 文件；
//   - exit 0  = output.json 已写（turn 跑完，里面可能是 status:"error"）；
//   - exit 70 = 基建失败（envelope 坏 / egress 文件不可读 / 引擎崩 / 写不出结果）
//               → cloud 侧映射 `runtime_unavailable`。
//
// MUST-1：`--key-file`（owner provider token 表）已被 `--egress-file` 取代——pod 内
// 不再有 provider 凭据，模型出口走 cloud 的 turn-scoped 端点。

import { Command } from 'commander';
import { TURN_EXIT_INFRA, TURN_EXIT_OK, TURN_PROTOCOL_VERSION, TURN_MAX_HISTORY_MESSAGES, TURN_MAX_IMAGES } from '../../turn/protocol.js';

/** 本 increment 唯一承载的引擎（envelope 协议与 adapter 正交，后续引擎走同一文件契约）。 */
const SUPPORTED_ADAPTERS = ['pi-core'] as const;

export function buildTurnCommand(): Command {
  const cmd = new Command('turn').description('One-shot environment turn (in-pod runtime entry; Gate B+ protocol v1)');

  cmd.command('capabilities').description('Print the turn protocol capabilities as JSON').action(() => {
    process.stdout.write(JSON.stringify({ protocolVersion: TURN_PROTOCOL_VERSION, maintenance: { assetIngest: 1 }, history: { text: true, principalImages: true, maxMessages: TURN_MAX_HISTORY_MESSAGES, maxImages: TURN_MAX_IMAGES } }) + '\n');
  });

  cmd
    .command('run')
    .description('Run one turn from a TurnEnvelopeV1 file and write TurnResultV1')
    .requiredOption('--input <path>', 'TurnEnvelopeV1 JSON path (written by the cloud port)')
    .requiredOption('--output <path>', 'TurnResultV1 JSON output path')
    .requiredOption(
      '--egress-file <path>',
      'turn egress descriptor (JSON {url,token,model,provider}; deleted after read)',
    )
    .option('--adapter <name>', `engine adapter (${SUPPORTED_ADAPTERS.join(' | ')})`, 'pi-core')
    .option('--deadline-ms <ms>', 'soft deadline for this turn (overrides envelope.deadlineMs)')
    .action(
      async (opts: { input: string; output: string; egressFile: string; adapter: string; deadlineMs?: string }) => {
        const adapter = String(opts.adapter ?? '').trim().toLowerCase();
        if (!(SUPPORTED_ADAPTERS as readonly string[]).includes(adapter)) {
          // 未知引擎不静默回退（同 cloud 侧「未知值不静默降级」纪律）。
          process.stderr.write(
            `[turn] unsupported adapter '${opts.adapter}' (supported: ${SUPPORTED_ADAPTERS.join(', ')})\n`,
          );
          process.exit(TURN_EXIT_INFRA);
        }
        const deadlineMsOverride = opts.deadlineMs !== undefined ? Number(opts.deadlineMs) : undefined;
        if (deadlineMsOverride !== undefined && (!Number.isFinite(deadlineMsOverride) || deadlineMsOverride <= 0)) {
          process.stderr.write(`[turn] --deadline-ms must be a positive number, got '${opts.deadlineMs}'\n`);
          process.exit(TURN_EXIT_INFRA);
        }
        const { runTurnFile } = await import('../../turn/runner.js');
        const code = await runTurnFile({
          inputPath: opts.input,
          outputPath: opts.output,
          egressFilePath: opts.egressFile,
          ...(deadlineMsOverride !== undefined ? { deadlineMsOverride } : {}),
        });
        // exit code 是契约的一部分（见文件头）——不走 commander 的错误路径。
        process.exit(code === TURN_EXIT_OK ? TURN_EXIT_OK : TURN_EXIT_INFRA);
      },
    );

  return cmd;
}
