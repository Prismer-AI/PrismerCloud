// `cloud approval request-human` — submit a structured human-approval request.
//
// Backs the v2.0 `human-approval` built-in skill
// (see sdk/prismer-cloud/built-in-skills/human-approval/SKILL.md).
//
// Cloud API: POST /api/im/approvals  (see src/im/api/approvals.ts).
// The PrismerClient does not yet expose a typed approvals sub-client, so this
// command uses the public `client.im.request()` IM-request escape hatch.

import { Command } from 'commander';
import { PrismerClient } from '../index';

type ClientFactory = () => PrismerClient;

function resolveWorkspaceId(flag?: string): string | undefined {
  if (flag) return flag;
  if (typeof process !== 'undefined' && process.env?.PRISMER_WORKSPACE_ID) {
    return process.env.PRISMER_WORKSPACE_ID;
  }
  return undefined;
}

interface ApprovalCreateResponse {
  ok: boolean;
  data?: {
    id: string;
    workspaceId?: string;
    conversationId?: string | null;
    taskId?: string | null;
    category?: string;
    title?: string;
    status: string;
    expiresAt?: string | null;
    options?: Array<{ value: string; label?: string }>;
  };
  error?: { code: string; message: string };
}

export function register(parent: Command, getIMClient: ClientFactory, _getAPIClient: ClientFactory): void {
  const approval = parent
    .command('approval')
    .description('Submit and manage human approval requests');

  // -------------------------------------------------------------------------
  // approval request-human
  // -------------------------------------------------------------------------
  approval
    .command('request-human')
    .description('Submit a human approval request and stop the current turn')
    .requiredOption('--action <text>', 'one-sentence summary of the gated action')
    .requiredOption('--context <text>', 'multi-sentence framing for the human')
    .requiredOption('--risk <text>', 'what breaks if approved wrongly; what is reversible')
    .option('--options <opt...>', 'explicit choice values (defaults to approve/reject if omitted)')
    .option('--task-id <id>', 'task to resume when the human decides')
    .option('--conversation-id <id>', 'conversation context for the request')
    .option('--workspace-id <id>', 'workspace id (defaults to PRISMER_WORKSPACE_ID env)')
    .option('--category <category>', 'approval category label', 'human-approval')
    .option('--expires-in <seconds>', 'expiration window in seconds (default 24h)', parseIntOpt)
    .option('--json', 'output raw JSON response')
    .action(async (opts: {
      action: string;
      context: string;
      risk: string;
      options?: string[];
      taskId?: string;
      conversationId?: string;
      workspaceId?: string;
      category: string;
      expiresIn?: number;
      json?: boolean;
    }) => {
      // The cloud requires at least one of conversationId / taskId to anchor
      // the approval. Bail early with a clear message rather than letting the
      // server return a generic validation error.
      if (!opts.conversationId && !opts.taskId) {
        process.stderr.write(
          'Error: --conversation-id or --task-id is required (human-approval needs an anchor).\n',
        );
        process.exit(1);
      }

      const workspaceId = resolveWorkspaceId(opts.workspaceId);

      // Compose the context block. We fold `--risk` into the same field the
      // cloud stores (`context`) because the API model only has one free-text
      // field, but we also surface the risk separately in `metadata.risk` so
      // downstream renderers (mobile, web) can highlight it.
      const composedContext = `${opts.context}\n\nRisk: ${opts.risk}`;

      // Default option set when caller didn't pass any.
      const optionList = (opts.options && opts.options.length > 0)
        ? opts.options.map((v) => ({ value: v, label: v }))
        : [
            { value: 'approve', label: 'Approve' },
            { value: 'reject', label: 'Reject' },
          ];

      const metadata: Record<string, unknown> = {
        risk: opts.risk,
        source: 'cli:prismer-approval-request-human',
      };

      const body: Record<string, unknown> = {
        category: opts.category,
        title: opts.action,
        context: composedContext,
        options: optionList,
        metadata,
      };
      if (workspaceId) body.workspaceId = workspaceId;
      if (opts.conversationId) body.conversationId = opts.conversationId;
      if (opts.taskId) body.taskId = opts.taskId;
      if (opts.expiresIn) body.expiresInSeconds = opts.expiresIn;

      try {
        const client = getIMClient();
        // No first-class approvals sub-client yet — use the public IM-request
        // escape hatch. Same auth + retry + offline routing as the typed
        // sub-clients.
        const res = await client.im.request<ApprovalCreateResponse>(
          'POST',
          '/api/im/approvals',
          body,
        );

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
        }

        if (!res.ok) {
          if (!opts.json) {
            process.stderr.write(`Error: ${res.error?.message || 'approval submission failed'}\n`);
          }
          process.exit(1);
        }

        const data = res.data!;
        const summary = {
          approvalId: data.id,
          status: data.status ?? 'pending',
          expiresAt: data.expiresAt ?? null,
        };

        if (!opts.json) {
          process.stdout.write(JSON.stringify(summary) + '\n');
        }

        // Human-readable line on stderr so it shows up alongside the CLI
        // invocation in agent logs without polluting JSON stdout.
        process.stderr.write(
          `Submitted approval request ${data.id}. Stopping this turn.\n`,
        );
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });
}

function parseIntOpt(value: string): number {
  const n = parseInt(value, 10);
  if (Number.isNaN(n) || n <= 0) {
    throw new Error(`expected positive integer, got "${value}"`);
  }
  return n;
}
