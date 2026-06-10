import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { pathToFileURL } from 'url';
import { registerContextLoad } from './tools/context-load.js';
import { registerContextSave } from './tools/context-save.js';
import { registerParse } from './tools/parse.js';
import { registerDiscover } from './tools/discover.js';
import { registerSendMessage } from './tools/send-message.js';
import { registerImListAgents } from './tools/im-list-agents.js';
import { registerImSendToAgent } from './tools/im-send-to-agent.js';
import { registerSendFile } from './tools/send-file.js';
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
import { registerRequestHumanApproval } from './tools/request-human-approval.js';
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
import { registerAssetSearch } from './tools/asset-search.js';
import { registerAssetDescribe } from './tools/asset-describe.js';
import { registerAssetRead } from './tools/asset-read.js';
import { getApiKey, getMcpAllowlist, isToolAllowed } from './lib/client.js';

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
  version: '2.0.8',
});

export type ToolRegistration = { name: string; register: (server: McpServer) => void };

export const toolRegistrations: ToolRegistration[] = [
  { name: 'prismer.context.load', register: registerContextLoad },
  { name: 'prismer.context.save', register: registerContextSave },
  { name: 'prismer.parse.document', register: registerParse },
  { name: 'prismer.agent.discover', register: registerDiscover },
  { name: 'prismer.message.send', register: registerSendMessage },
  { name: 'prismer.conversation.listAgents', register: registerImListAgents },
  { name: 'prismer.agent.send', register: registerImSendToAgent },
  { name: 'prismer.message.sendFile', register: registerSendFile },
  { name: 'prismer.message.edit', register: registerEditMessage },
  { name: 'prismer.message.delete', register: registerDeleteMessage },
  { name: 'prismer.message.react', register: registerReactMessage },
  { name: 'prismer.evolve.analyze', register: registerEvolveAnalyze },
  { name: 'prismer.evolve.record', register: registerEvolveRecord },
  { name: 'prismer.evolve.createGene', register: registerEvolveCreateGene },
  { name: 'prismer.evolve.distill', register: registerEvolveDistill },
  { name: 'prismer.evolve.browse', register: registerEvolveBrowse },
  { name: 'prismer.evolve.import', register: registerEvolveImport },
  { name: 'prismer.evolve.report', register: registerEvolveReport },
  { name: 'prismer.evolve.achievements', register: registerEvolveAchievements },
  { name: 'prismer.evolve.sync', register: registerEvolveSync },
  { name: 'prismer.evolve.exportSkill', register: registerEvolveExportSkill },
  { name: 'prismer.evolve.publish', register: registerEvolvePublish },
  { name: 'prismer.evolve.delete', register: registerEvolveDelete },
  { name: 'prismer.memory.write', register: registerMemoryWrite },
  { name: 'prismer.memory.read', register: registerMemoryRead },
  { name: 'prismer.memory.recall', register: registerRecall },
  { name: 'prismer.asset.search', register: registerAssetSearch },
  { name: 'prismer.asset.describe', register: registerAssetDescribe },
  { name: 'prismer.asset.read', register: registerAssetRead },
  { name: 'prismer.task.create', register: registerCreateTask },
  { name: 'prismer.task.list', register: registerListTasks },
  { name: 'prismer.task.get', register: registerGetTask },
  { name: 'prismer.task.update', register: registerUpdateTask },
  { name: 'prismer.task.complete', register: registerCompleteTask },
  { name: 'prismer.task.approve', register: registerApproveTask },
  { name: 'prismer.task.reject', register: registerRejectTask },
  { name: 'prismer.task.cancel', register: registerCancelTask },
  { name: 'prismer.approval.request_human_approval', register: registerRequestHumanApproval },
  { name: 'prismer.skill.install', register: registerSkillInstall },
  { name: 'prismer.skill.uninstall', register: registerSkillUninstall },
  { name: 'prismer.skill.installed', register: registerSkillInstalled },
  { name: 'prismer.skill.content', register: registerSkillContent },
  { name: 'prismer.skill.search', register: registerSkillSearch },
  { name: 'prismer.skill.sync', register: registerSkillSync },
  { name: 'skill_sync', register: (mcpServer) => registerSkillSync(mcpServer, 'skill_sync') },
  { name: 'prismer.session.checklist', register: registerSessionChecklist },
  { name: 'prismer.community.post', register: registerCommunityPost },
  { name: 'prismer.community.browse', register: registerCommunityBrowse },
  { name: 'prismer.community.search', register: registerCommunitySearch },
  { name: 'prismer.community.detail', register: registerCommunityDetail },
  { name: 'prismer.community.comment', register: registerCommunityComment },
  { name: 'prismer.community.vote', register: registerCommunityVote },
  { name: 'prismer.community.answer', register: registerCommunityAnswer },
  { name: 'prismer.community.adopt', register: registerCommunityAdopt },
  { name: 'prismer.community.bookmark', register: registerCommunityBookmark },
  { name: 'prismer.community.report', register: registerCommunityReport },
  { name: 'prismer.community.edit', register: registerCommunityEdit },
  { name: 'prismer.community.delete', register: registerCommunityDelete },
  { name: 'prismer.community.notifications', register: registerCommunityNotifications },
  { name: 'prismer.community.follow', register: registerCommunityFollow },
  { name: 'prismer.community.profile', register: registerCommunityProfileMcp },
  { name: 'prismer.contact.search', register: registerContactSearch },
  { name: 'prismer.contact.request', register: registerContactRequest },
];

export function selectAllowedToolRegistrations(registrations: ToolRegistration[], rules = getMcpAllowlist()): ToolRegistration[] {
  return registrations.filter((entry) => isToolAllowed(entry.name, rules));
}

const allowlist = getMcpAllowlist();
const allowedToolRegistrations = selectAllowedToolRegistrations(toolRegistrations, allowlist);
let registeredTools = 0;
for (const entry of allowedToolRegistrations) {
  entry.register(server);
  registeredTools++;
}

async function main() {
  if (!getApiKey()) {
    console.error('[Prismer MCP] No API key found. To enable all tools:');
    console.error('  Run: npx prismer setup         (opens browser, auto-receives key)');
    console.error('    or: npx prismer setup --manual (paste key manually)');
    console.error('  (Saves to ~/.prismer/config.toml — tools will work after restart)\n');
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  const mode = allowlist.length === 0 ? 'all tools' : `${registeredTools}/${toolRegistrations.length} allowlisted tools`;
  console.error(`[Prismer MCP] Server running on stdio (${mode})`);
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  return !!entry && import.meta.url === pathToFileURL(entry).href;
}

if (isEntrypoint()) {
  main().catch((error) => {
    console.error('[Prismer MCP] Fatal error:', error);
    process.exit(1);
  });
}
