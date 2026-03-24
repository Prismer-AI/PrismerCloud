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
import { registerMemoryWrite } from './tools/memory-write.js';
import { registerMemoryRead } from './tools/memory-read.js';
import { registerRecall } from './tools/recall.js';
import { registerCreateTask } from './tools/create-task.js';
import { registerSkillInstall } from './tools/skill-install.js';
import { registerSkillSearch } from './tools/skill-search.js';
import { getApiKey } from './lib/client.js';

const server = new McpServer({
  name: 'prismer',
  version: '1.7.2',
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
registerMemoryWrite(server);
registerMemoryRead(server);
registerRecall(server);
registerCreateTask(server);
registerSkillInstall(server);
registerSkillSearch(server);

async function main() {
  if (!getApiKey()) {
    console.error('[Prismer MCP] PRISMER_API_KEY environment variable is required.');
    console.error('[Prismer MCP] Get your key at https://prismer.cloud/dashboard');
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[Prismer MCP] Server running on stdio');
}

main().catch((error) => {
  console.error('[Prismer MCP] Fatal error:', error);
  process.exit(1);
});
