/**
 * `cloud code grep` — release201/07 §4.3 source-kind helper.
 *
 * Searches a repo directory (whitelisted to PRISMER_WORKSPACE_ROOT or
 * $HOME/.prismer/agents/<agentId>/scratch) for a pattern and emits matched
 * snippets the skill-authoring agent bundles as `references/*`.
 *
 * Usage:
 *   cloud code grep <pattern> --repo <abs-path> [--glob "*.ts"] [--max-matches 50]
 *
 * Output (JSON):
 *   [ { path, line, snippet, sha256 } ]
 */

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';

type ClientFactory = () => unknown;

const DEFAULT_MAX_MATCHES = 50;
const SCRATCH_DIR_GLOB = path.join(os.homedir(), '.prismer', 'agents');

function isPathWhitelisted(repo: string): boolean {
  const abs = path.resolve(repo);
  const workspaceRoot = process.env.PRISMER_WORKSPACE_ROOT;
  if (workspaceRoot) {
    const wsAbs = path.resolve(workspaceRoot);
    if (abs === wsAbs || abs.startsWith(wsAbs + path.sep)) return true;
  }
  // $HOME/.prismer/agents/<agentId>/scratch
  if (abs.startsWith(SCRATCH_DIR_GLOB + path.sep)) {
    const rel = abs.slice(SCRATCH_DIR_GLOB.length + 1);
    const parts = rel.split(path.sep);
    if (parts.length >= 2 && parts[1] === 'scratch') return true;
  }
  return false;
}

function walk(dir: string, glob: string | undefined, acc: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      // skip common heavy directories
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === 'build') continue;
      walk(full, glob, acc);
    } else if (e.isFile()) {
      if (!glob || matchGlob(e.name, glob)) acc.push(full);
    }
  }
}

function matchGlob(name: string, glob: string): boolean {
  // Tiny glob: supports `*.ext` only.
  if (glob.startsWith('*.')) {
    return name.endsWith(glob.slice(1));
  }
  return name === glob;
}

export function register(parent: Command, _getIMClient: ClientFactory, _getAPIClient: ClientFactory): void {
  const code = parent.command('code').description('Local code-source helpers for skill-authoring (release201/07)');

  code
    .command('grep <pattern>')
    .description('Grep a whitelisted repo path for a pattern; output matched snippets as JSON')
    .option('--repo <abs-path>', 'Absolute repo path (must be inside PRISMER_WORKSPACE_ROOT or ~/.prismer/agents/<id>/scratch)')
    .option('--glob <pattern>', 'File-name glob (e.g. *.ts)')
    .option('--max-matches <n>', 'Maximum number of matches to return', String(DEFAULT_MAX_MATCHES))
    .option('--json', 'Output JSON (default)', true)
    .action(async (
      pattern: string,
      opts: { repo?: string; glob?: string; maxMatches: string; json: boolean },
    ) => {
      if (!opts.repo) {
        process.stderr.write('Error: --repo <abs-path> is required\n');
        process.exit(1);
      }
      if (!isPathWhitelisted(opts.repo)) {
        process.stderr.write(
          `Error: --repo path ${opts.repo} is not whitelisted; only PRISMER_WORKSPACE_ROOT or ~/.prismer/agents/<id>/scratch are allowed\n`,
        );
        process.exit(1);
      }
      const maxMatches = parseInt(opts.maxMatches, 10) || DEFAULT_MAX_MATCHES;
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch (err) {
        process.stderr.write(`Error: invalid regex pattern: ${(err as Error).message}\n`);
        process.exit(1);
      }
      const files: string[] = [];
      walk(opts.repo, opts.glob, files);
      const results: Array<{ path: string; line: number; snippet: string; sha256: string }> = [];
      for (const file of files) {
        if (results.length >= maxMatches) break;
        let body: string;
        try {
          body = fs.readFileSync(file, 'utf-8');
        } catch {
          continue;
        }
        const lines = body.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            const startLine = Math.max(0, i - 1);
            const endLine = Math.min(lines.length, i + 4);
            const snippet = lines.slice(startLine, endLine).join('\n');
            const sha256 = crypto.createHash('sha256').update(snippet).digest('hex');
            results.push({
              path: path.relative(opts.repo!, file),
              line: i + 1,
              snippet,
              sha256,
            });
            if (results.length >= maxMatches) break;
          }
        }
      }
      process.stdout.write(JSON.stringify(results, null, 2) + '\n');
    });
}
