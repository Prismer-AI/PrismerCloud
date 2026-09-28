// `cloud git <workdirs|commit|branch|merge|push>` — apc/05 §1 A2 (S8 git-ops).
//
// The agent-facing half of the daemon git RPC. Full chain:
//
//   cloud git commit            (this file)
//     → POST /api/im/workspaces/:wid/workdirs/:id/git   (src/im/api/workdirs.ts)
//     → GitService.runGit                               (src/im/services/git.service.ts)
//     → WsRpcService.invoke 'agent.git.exec'            (src/im/services/ws-rpc.service.ts)
//     → daemon Runner case 'agent.git.exec'             (runtime/src/daemon/runner.ts)
//     → runGitExecRequest → gitRpc                      (runtime/src/daemon/git-rpc.ts)
//     ← 'agent.git.reply' ∈ WS_RPC_REPLY_TYPES          (ws-rpc.service.ts)
//
// The cwd is NEVER passed from here — it is read off the IMWorkdir row cloud
// side, and jailed again daemon side. `--workspace` / `--daemon` default to the
// dispatch env (`PRISMER_WORKSPACE_ID` / `PRISMER_DAEMON_ID`, injected by
// runtime/src/adapters/prismer-env.ts).
//
// Conflicts are NOT auto-resolved (apc/00 §3 不变量 6): a merge conflict exits
// non-zero with the unmerged file list on stdout and the worktree left as-is,
// so the skill escalates to a human instead of forcing a merge.

import { Command } from 'commander';
import { PrismerClient } from '../index';

type ClientFactory = () => PrismerClient;

// `ApiResponse.error` is `string | { code, message, details? }` (src/im/types).
// Both shapes really occur on these routes, so both are typed here — reading
// only `.code`/`.message` off a string yields `undefined` and silently turns a
// real diagnosis ("Workspace not found") into a blank generic failure.
type ErrorEnvelope = string | { code?: string; message?: string; details?: { files?: string[] } };

interface GitEnvelope {
  ok?: boolean;
  data?: {
    op: string;
    cwd: string;
    stdout: string;
    ref?: string;
    sha?: string;
  };
  error?: ErrorEnvelope;
}

interface WorkdirsEnvelope {
  ok?: boolean;
  data?: Array<{ id: string; cwd: string; source: string; title?: string | null; status?: string }>;
  error?: ErrorEnvelope;
}

/**
 * Normalize either error shape into `{ code, message, files }`.
 *
 * An unstructured (string) error gets code `error`, NOT `git_failed`: "the
 * server refused you" and "git broke" are different facts and the second one
 * sends the operator to the wrong place. The message is never allowed to end up
 * empty while the server actually said something.
 */
function normalizeError(
  err: ErrorEnvelope | undefined,
  fallbackMessage: string,
): { code: string; message: string; files: string[] } {
  if (typeof err === 'string') {
    return { code: 'error', message: err.trim() || fallbackMessage, files: [] };
  }
  return {
    code: err?.code ?? 'git_failed',
    message: err?.message?.trim() || fallbackMessage,
    files: err?.details?.files ?? [],
  };
}

interface CommonOpts {
  workspace?: string;
  daemon?: string;
  json?: boolean;
}

function resolveScope(opts: CommonOpts): { workspaceId: string; daemonId: string } {
  const workspaceId = (opts.workspace || process.env.PRISMER_WORKSPACE_ID || '').trim();
  const daemonId = (opts.daemon || process.env.PRISMER_DAEMON_ID || '').trim();
  if (!workspaceId) {
    process.stderr.write('Error: --workspace is required (or set PRISMER_WORKSPACE_ID)\n');
    process.exit(1);
  }
  if (!daemonId) {
    process.stderr.write('Error: --daemon is required (or set PRISMER_DAEMON_ID)\n');
    process.exit(1);
  }
  return { workspaceId, daemonId };
}

async function runOp(
  getIMClient: ClientFactory,
  workdirId: string,
  op: 'commit' | 'branch' | 'merge' | 'push',
  opts: CommonOpts,
  body: Record<string, unknown>,
): Promise<void> {
  const { workspaceId, daemonId } = resolveScope(opts);
  const client = getIMClient();
  let res: GitEnvelope;
  try {
    res = await client.im.request<GitEnvelope>(
      'POST',
      `/api/im/workspaces/${encodeURIComponent(workspaceId)}/workdirs/${encodeURIComponent(workdirId)}/git`,
      { daemonId, op, ...body },
    );
  } catch (err: unknown) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
    return;
  }

  if (!res.ok || !res.data) {
    const { code, message, files } = normalizeError(res.error, 'git failed');
    if (opts.json) {
      process.stdout.write(JSON.stringify({ ok: false, op, code, message, files }, null, 2) + '\n');
    } else {
      process.stderr.write(`Error [${code}]: ${message}\n`);
      if (code === 'conflict') {
        // apc/05 §1 A2: stop, list the conflicted files, escalate. The worktree
        // is left exactly as git left it — do NOT abort or reset it.
        process.stderr.write(
          `Merge conflict — NOT auto-resolved. Escalate to a human.\nConflicted files (${files.length}):\n`,
        );
        for (const f of files) process.stderr.write(`  ${f}\n`);
      }
    }
    process.exit(1);
    return;
  }

  const d = res.data;
  if (opts.json) {
    process.stdout.write(JSON.stringify({ ok: true, ...d }, null, 2) + '\n');
  } else {
    process.stdout.write(`${d.op} ok\n`);
    if (d.sha) process.stdout.write(`sha:  ${d.sha}\n`);
    if (d.ref) process.stdout.write(`ref:  ${d.ref}\n`);
    process.stdout.write(`cwd:  ${d.cwd}\n`);
    if (d.stdout) process.stdout.write(`\n${d.stdout}\n`);
  }
}

export function register(parent: Command, getIMClient: ClientFactory, _getAPIClient: ClientFactory): void {
  const git = parent
    .command('git')
    .description('Run git ops (commit/branch/merge/push) in a workdir on the bound daemon');

  const common = (cmd: Command): Command =>
    cmd
      .option('--workspace <id>', 'Workspace id (default: $PRISMER_WORKSPACE_ID)')
      .option('--daemon <id>', 'Daemon id owning the workdir (default: $PRISMER_DAEMON_ID)')
      .option('--json', 'output raw JSON');

  common(git.command('workdirs').description('List repo workdirs in the workspace (source of --workdir ids)')).action(
    async (opts: CommonOpts) => {
      const { workspaceId } = resolveScope({ ...opts, daemon: opts.daemon || 'n/a' });
      const client = getIMClient();
      const res = await client.im.request<WorkdirsEnvelope>(
        'GET',
        `/api/im/workspaces/${encodeURIComponent(workspaceId)}/workdirs`,
      );
      if (!res.ok || !Array.isArray(res.data)) {
        const { code, message } = normalizeError(res.error, 'list workdirs failed');
        process.stderr.write(`Error [${code}]: ${message}\n`);
        process.exit(1);
        return;
      }
      if (opts.json) {
        process.stdout.write(JSON.stringify(res.data, null, 2) + '\n');
        return;
      }
      for (const w of res.data) process.stdout.write(`${w.id}  ${w.source.padEnd(15)} ${w.cwd}\n`);
    },
  );

  common(
    git
      .command('commit <workdirId>')
      .description('Commit staged changes in the workdir')
      .requiredOption('-m, --message <text>', 'Commit message'),
  ).action(async (workdirId: string, opts: CommonOpts & { message: string }) => {
    await runOp(getIMClient, workdirId, 'commit', opts, { message: opts.message });
  });

  common(
    git
      .command('branch <workdirId>')
      .description('Create and switch to a new branch')
      .requiredOption('--name <branch>', 'Branch name'),
  ).action(async (workdirId: string, opts: CommonOpts & { name: string }) => {
    await runOp(getIMClient, workdirId, 'branch', opts, { branch: opts.name });
  });

  common(
    git
      .command('merge <workdirId>')
      .description('Merge a source ref into the current branch (conflicts escalate, never auto-resolved)')
      .requiredOption('--source <ref>', 'Ref to merge in'),
  ).action(async (workdirId: string, opts: CommonOpts & { source: string }) => {
    await runOp(getIMClient, workdirId, 'merge', opts, { source: opts.source });
  });

  common(
    git
      .command('push <workdirId>')
      .description('Push HEAD to a branch, or push a tag (prod-triggering tags are refused)')
      .option('--branch <name>', 'Target branch (required unless --tag)')
      .option('--tag <name>', 'Push this tag instead of a branch')
      .option('--remote <name>', 'Remote name (must be on the daemon allowlist; default origin)'),
  ).action(
    async (workdirId: string, opts: CommonOpts & { branch?: string; tag?: string; remote?: string }) => {
      if (!opts.branch && !opts.tag) {
        process.stderr.write('Error: --branch or --tag is required\n');
        process.exit(1);
        return;
      }
      await runOp(getIMClient, workdirId, 'push', opts, {
        ...(opts.branch ? { branch: opts.branch } : {}),
        ...(opts.tag ? { tag: opts.tag } : {}),
        ...(opts.remote ? { remote: opts.remote } : {}),
      });
    },
  );
}
