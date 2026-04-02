import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { writeFileSync } from 'fs';
import { join } from 'path';

// ─── In-process state (lifetime = MCP server process = CC session) ───

interface ChecklistItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  addedAt: string;
  completedAt?: string;
}

const checklist: ChecklistItem[] = [];

/**
 * Dump checklist state to disk for session-end hook to pick up.
 * Called on process exit (SIGTERM/SIGINT).
 */
function dumpChecklist() {
  if (checklist.length === 0) return;
  const cacheDir = process.env.CLAUDE_PLUGIN_DATA || join(process.cwd(), '.cache');
  try {
    writeFileSync(
      join(cacheDir, 'checklist-summary.json'),
      JSON.stringify(checklist, null, 2),
    );
  } catch {
    // Best-effort; non-critical
  }
}

// Register shutdown handlers
process.on('SIGTERM', dumpChecklist);
process.on('SIGINT', dumpChecklist);
process.on('exit', dumpChecklist);

// ─── MCP Tool ─────────────────────────────────────────────

function formatChecklist(): string {
  if (checklist.length === 0) return 'Checklist is empty.';
  const statusIcon = { pending: '[ ]', in_progress: '[~]', completed: '[x]' };
  return checklist
    .map((item, i) => `${i}. ${statusIcon[item.status]} ${item.content}`)
    .join('\n');
}

export function registerSessionChecklist(server: McpServer) {
  server.tool(
    'session_checklist',
    'Lightweight session-scoped todo list. Items live only for this session (not persisted to cloud). ' +
      'Completed items are automatically reported as evolution signals when the session ends. ' +
      'Use to track progress on multi-step tasks within a single session.',
    {
      action: z.enum(['add', 'update', 'list', 'clear']).describe(
        'add: add new item, update: change status of item by index, list: show all items, clear: remove all items',
      ),
      content: z.string().optional().describe('Item description (required for add)'),
      index: z.number().optional().describe('Item index to update (required for update)'),
      status: z
        .enum(['pending', 'in_progress', 'completed'])
        .optional()
        .describe('New status (required for update)'),
    },
    async (args) => {
      switch (args.action) {
        case 'add': {
          if (!args.content) {
            return { content: [{ type: 'text' as const, text: 'Error: content is required for add' }] };
          }
          checklist.push({
            content: args.content,
            status: 'pending',
            addedAt: new Date().toISOString(),
          });
          const text = `Added item #${checklist.length - 1}: "${args.content}"\n\n${formatChecklist()}`;
          return { content: [{ type: 'text' as const, text }] };
        }

        case 'update': {
          if (args.index === undefined || args.index < 0 || args.index >= checklist.length) {
            return {
              content: [{ type: 'text' as const, text: `Error: invalid index ${args.index} (0-${checklist.length - 1})` }],
            };
          }
          if (!args.status) {
            return { content: [{ type: 'text' as const, text: 'Error: status is required for update' }] };
          }
          checklist[args.index].status = args.status;
          if (args.status === 'completed') {
            checklist[args.index].completedAt = new Date().toISOString();
          }
          if (args.content) {
            checklist[args.index].content = args.content;
          }
          const text = `Updated item #${args.index} → ${args.status}\n\n${formatChecklist()}`;
          return { content: [{ type: 'text' as const, text }] };
        }

        case 'list': {
          const completed = checklist.filter((i) => i.status === 'completed').length;
          const total = checklist.length;
          const header = total > 0 ? `## Session Checklist (${completed}/${total} done)\n\n` : '';
          return { content: [{ type: 'text' as const, text: header + formatChecklist() }] };
        }

        case 'clear': {
          const count = checklist.length;
          checklist.length = 0;
          return { content: [{ type: 'text' as const, text: `Cleared ${count} items.` }] };
        }

        default:
          return { content: [{ type: 'text' as const, text: `Unknown action: ${args.action}` }] };
      }
    },
  );
}
