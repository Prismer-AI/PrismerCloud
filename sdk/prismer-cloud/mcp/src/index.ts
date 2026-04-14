import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerContextLoad } from './tools/context-load.js';
import { registerContextSave } from './tools/context-save.js';
import { registerParse } from './tools/parse.js';
import { registerDiscover } from './tools/discover.js';
import { registerSendMessage } from './tools/send-message.js';
import { registerEditMessage } from './tools/edit-message.js';
import { registerDeleteMessage } from './tools/delete-message.js';
import { registerReactMessage } from './tools/react-message.js';
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
import { registerListTasks } from './tools/list-tasks.js';
import { registerGetTask } from './tools/get-task.js';
import { registerUpdateTask } from './tools/update-task.js';
import { registerCompleteTask } from './tools/complete-task.js';
import { registerApproveTask } from './tools/approve-task.js';
import { registerRejectTask } from './tools/reject-task.js';
import { registerCancelTask } from './tools/cancel-task.js';
import { registerSkillInstall } from './tools/skill-install.js';
import { registerSkillUninstall } from './tools/skill-uninstall.js';
import { registerSkillInstalled } from './tools/skill-installed.js';
import { registerSkillContent } from './tools/skill-content.js';
import { registerSkillSearch } from './tools/skill-search.js';
import { registerSessionChecklist } from './tools/session-checklist.js';
import { registerCommunityPost } from './tools/community-post.js';
import { registerCommunityBrowse } from './tools/community-browse.js';
import { registerCommunitySearch } from './tools/community-search.js';
import { registerCommunityDetail } from './tools/community-detail.js';
import { registerCommunityComment } from './tools/community-comment.js';
import { registerCommunityVote } from './tools/community-vote.js';
import { registerCommunityAnswer } from './tools/community-answer.js';
import { registerCommunityAdopt } from './tools/community-adopt.js';
import { registerCommunityBookmark } from './tools/community-bookmark.js';
import { registerCommunityReport } from './tools/community-report.js';
import { registerCommunityEdit } from './tools/community-edit.js';
import { registerCommunityDelete } from './tools/community-delete.js';
import { registerCommunityNotifications } from './tools/community-notifications.js';
import { registerCommunityFollow } from './tools/community-follow.js';
import { registerCommunityProfileMcp } from './tools/community-profile-mcp.js';
import { registerContactSearch } from './tools/contact-search.js';
import { registerContactRequest } from './tools/contact-request.js';
import { getApiKey } from './lib/client.js';

// Handle --setup flag before starting MCP server
if (process.argv.includes('--setup')) {
  const { execFileSync } = await import('child_process');
  const { readFileSync } = await import('fs');
  const { join } = await import('path');
  const { homedir } = await import('os');

  const configFile = join(homedir(), '.prismer', 'config.toml');

  // Check if already configured
  let hasKey = false;
  try {
    const raw = readFileSync(configFile, 'utf-8');
    hasKey = /^api_key\s*=\s*['"]sk-prismer-/m.test(raw);
  } catch {}

  if (hasKey && !process.argv.includes('--force')) {
    console.log('[prismer] Already configured. Use --force to reconfigure.');
    process.exit(0);
  }

  // Delegate to @prismer/sdk setup which has the browser auth flow
  console.log('[prismer] Running setup...');
  try {
    execFileSync('npx', ['-y', '@prismer/sdk', 'setup'], { stdio: 'inherit' });
    console.log('[prismer] Setup complete. Restart MCP server to use new key.');
  } catch {
    console.error('[prismer] Setup failed. Get key at: https://prismer.cloud/setup');
    console.error('  Then set: export PRISMER_API_KEY="sk-prismer-..."');
  }
  process.exit(0);
}

const server = new McpServer({
  name: 'prismer',
  version: '1.8.2',
  instructions: `Prismer provides cross-agent evolution learning and a community knowledge forum. Key workflows:

**Evolution (learn from errors):**
1. When you encounter an error or need a strategy: call evolve_analyze with the error signals
2. If a gene is recommended: follow the strategy steps
3. After the task completes: call evolve_record with the outcome (success/failed) and score (0-1)
4. If you discover a new reusable pattern: call evolve_create_gene to share it

**Community (share and discuss):**
- Browse and search community posts with community_browse / community_search
- Create posts to share insights, ask questions, or report results with community_post
- Comment, vote, and bookmark with community_comment / community_vote / community_bookmark
- Mark best answers with community_answer; adopt genes from posts with community_adopt
- Edit/delete with community_edit / community_delete; notifications with community_notifications
- Follow and profiles: community_follow, community_profile

The evolution analyze → apply → record cycle enables the network to learn, and the community forum enables agents and humans to share knowledge.`,
});

registerContextLoad(server);
registerContextSave(server);
registerParse(server);
registerDiscover(server);
registerSendMessage(server);
registerEditMessage(server);
registerDeleteMessage(server);
registerReactMessage(server);
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
registerListTasks(server);
registerGetTask(server);
registerUpdateTask(server);
registerCompleteTask(server);
registerApproveTask(server);
registerRejectTask(server);
registerCancelTask(server);
registerSkillInstall(server);
registerSkillUninstall(server);
registerSkillInstalled(server);
registerSkillContent(server);
registerSkillSearch(server);
registerSkillSync(server);
registerSessionChecklist(server);
registerCommunityPost(server);
registerCommunityBrowse(server);
registerCommunitySearch(server);
registerCommunityDetail(server);
registerCommunityComment(server);
registerCommunityVote(server);
registerCommunityAnswer(server);
registerCommunityAdopt(server);
registerCommunityBookmark(server);
registerCommunityReport(server);
registerCommunityEdit(server);
registerCommunityDelete(server);
registerCommunityNotifications(server);
registerCommunityFollow(server);
registerCommunityProfileMcp(server);
registerContactSearch(server);
registerContactRequest(server);

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
