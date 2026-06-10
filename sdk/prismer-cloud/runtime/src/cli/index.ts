// `prismer` CLI entry. Wires runtime subcommand groups.

import { Command } from 'commander';
import { buildAdapterCommand } from './commands/adapter.js';
import { buildAgentCommand } from './commands/agent.js';
import { buildAssetCommand } from './commands/asset.js';
import { buildBannerCommand } from './commands/banner.js';
import { buildChatCommand } from './commands/chat.js';
import { buildConfigCommand } from './commands/config.js';
import { buildConversationCommand } from './commands/conversation.js';
import { buildCookbookCommand } from './commands/cookbook.js';
import { buildDaemonCommand } from './commands/daemon.js';
import { buildEventsCommand, buildEventsStatsCommand } from './commands/events.js';
import { buildMemoryCommand } from './commands/memory.js';
import { buildPairCommand } from './commands/pair.js';
import { buildProfileCommand } from './commands/profile.js';
import { buildQuoteCommand } from './commands/quote.js';
import { buildResetCommand } from './commands/reset.js';
import { buildSandboxCommand } from './commands/sandbox.js';
import { buildSessionCommand } from './commands/session.js';
import { buildSetupCommand } from './commands/setup.js';
import { buildSkillCommand } from './commands/skill.js';
import { buildStatusCommand } from './commands/status.js';
import { buildTaskCommand } from './commands/task.js';
import { buildWorkspaceCommand } from './commands/workspace.js';
import { applyCommonFlags, setUI, UI } from './ui.js';

// Kept in sync with /VERSION + sdk/prismer-cloud/runtime/package.json via
// sdk/build/version.sh. If you bump one place, bump them together.
const VERSION = '2.0.8';

export function buildProgram(): Command {
  const program = new Command('prismer')
    .description('Prismer Cloud daemon CLI (TS-only).')
    .version(VERSION);

  program.addCommand(buildBannerCommand());
  program.addCommand(buildSetupCommand());
  program.addCommand(buildConfigCommand());
  program.addCommand(buildDaemonCommand());
  program.addCommand(buildPairCommand());
  program.addCommand(buildResetCommand());
  program.addCommand(buildStatusCommand());
  program.addCommand(buildAdapterCommand());
  program.addCommand(buildAgentCommand());
  program.addCommand(buildProfileCommand());
  program.addCommand(buildTaskCommand());
  program.addCommand(buildWorkspaceCommand());
  program.addCommand(buildChatCommand());
  program.addCommand(buildConversationCommand());
  program.addCommand(buildQuoteCommand());
  program.addCommand(buildCookbookCommand());
  program.addCommand(buildAssetCommand());
  program.addCommand(buildSandboxCommand());
  program.addCommand(buildSessionCommand());
  program.addCommand(buildMemoryCommand());
  program.addCommand(buildSkillCommand());
  program.addCommand(buildEventsCommand());
  program.addCommand(buildEventsStatsCommand());

  return program;
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  // Strip --json / --quiet / --no-color / --color before commander sees them
  // so they're recognised on every command without per-subcommand wiring.
  const head = argv.slice(0, 2);
  const tail = argv.slice(2);
  const { mode, color, restArgv } = applyCommonFlags(tail);
  setUI(new UI({ mode, color }));
  await buildProgram().parseAsync([...head, ...restArgv]);
}
