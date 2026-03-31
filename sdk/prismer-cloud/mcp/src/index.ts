import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerContextLoad } from './tools/context-load.js';
import { registerContextSave } from './tools/context-save.js';
import { registerParse } from './tools/parse.js';
import { registerDiscover } from './tools/discover.js';
import { registerSendMessage } from './tools/send-message.js';
import { registerEditMessage } from './tools/edit-message.js';
import { registerDeleteMessage } from './tools/delete-message.js';
import { registerEvolveAnalyze } from './tools/evolve-analyze.js';
import { registerEvolveRecord } from './tools/evolve-record.js';
import { registerEvolveCreateGene } from './tools/evolve-create-gene.js';
import { registerEvolveDistill } from './tools/evolve-distill.js';
import { registerEvolveBrowse } from './tools/evolve-browse.js';
import { registerEvolveImport } from './tools/evolve-import.js';
import { registerEvolveReport } from './tools/evolve-report.js';
import { registerEvolveAchievements } from './tools/evolve-achievements.js';
import { registerEvolveSync } from './tools/evolve-sync.js';
import { registerEvolveExportSkill } from './tools/evolve-export-skill.js';
import { registerEvolvePublish } from './tools/evolve-publish.js';
import { registerEvolveDelete } from './tools/evolve-delete.js';
import { registerSkillSync } from './tools/skill-sync.js';
import { registerMemoryWrite } from './tools/memory-write.js';
import { registerMemoryRead } from './tools/memory-read.js';
import { registerRecall } from './tools/recall.js';
import { registerCreateTask } from './tools/create-task.js';
import { registerSkillInstall } from './tools/skill-install.js';
import { registerSkillUninstall } from './tools/skill-uninstall.js';
import { registerSkillInstalled } from './tools/skill-installed.js';
import { registerSkillContent } from './tools/skill-content.js';
import { registerSkillSearch } from './tools/skill-search.js';
import { getApiKey } from './lib/client.js';

const server = new McpServer({
  name: 'prismer',
  version: '1.7.4',
  instructions: `Prismer provides cross-agent evolution learning. Key workflow:

1. When you encounter an error or need a strategy: call evolve_analyze with the error signals
2. If a gene is recommended: follow the strategy steps
3. After the task completes: call evolve_record with the outcome (success/failed) and score (0-1)
4. If you discover a new reusable pattern: call evolve_create_gene to share it

This analyze → apply → record cycle enables the evolution network to learn from your experience and help other agents facing similar problems.`,
});

registerContextLoad(server);
registerContextSave(server);
registerParse(server);
registerDiscover(server);
registerSendMessage(server);
registerEditMessage(server);
registerDeleteMessage(server);
registerEvolveAnalyze(server);
registerEvolveRecord(server);
registerEvolveCreateGene(server);
registerEvolveDistill(server);
registerEvolveBrowse(server);
registerEvolveImport(server);
registerEvolveReport(server);
registerEvolveAchievements(server);
registerEvolveSync(server);
registerEvolveExportSkill(server);
registerEvolvePublish(server);
registerEvolveDelete(server);
registerMemoryWrite(server);
registerMemoryRead(server);
registerRecall(server);
registerCreateTask(server);
registerSkillInstall(server);
registerSkillUninstall(server);
registerSkillInstalled(server);
registerSkillContent(server);
registerSkillSearch(server);
registerSkillSync(server);

async function main() {
  if (!getApiKey()) {
    console.error('[Prismer MCP] No API key found. To enable all tools:');
    console.error('  Run: npx prismer setup         (opens browser, auto-receives key)');
    console.error('    or: npx prismer setup --manual (paste key manually)');
    console.error('  (Saves to ~/.prismer/config.toml — tools will work after restart)\n');
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[Prismer MCP] Server running on stdio');
}

main().catch((error) => {
  console.error('[Prismer MCP] Fatal error:', error);
  process.exit(1);
});
