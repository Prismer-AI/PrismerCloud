import * as os from 'node:os';
import * as path from 'node:path';
import { realpathSync } from 'node:fs';

// ============================================================
// Public types
// ============================================================

export class UncPathError extends Error {
  constructor(p: string) {
    super(`UNC path rejected: ${p}`);
    this.name = 'UncPathError';
  }
}

export interface ResolveResult {
  resolvedPath: string;
  isSymlink: boolean;
  inSandbox: boolean;
}

// ============================================================
// D17: workspace realpath memo
// macOS /var/folders/... symlinks to /private/var/folders/...
// Without realpathSync on the workspace, startsWith would always fail
// for any file created under os.tmpdir() on macOS.
// We memo so repeated calls with the same workspace pay the syscall once.
// ============================================================

const workspaceCache = new Map<string, string>();

function realWorkspace(workspace: string): string {
  const cached = workspaceCache.get(workspace);
  if (cached !== undefined) return cached;
  const real = realpathSync(workspace);
  workspaceCache.set(workspace, real);
  return real;
}

// ============================================================
// Path expansion helpers
// ============================================================

function expandPath(inputPath: string): string {
  // Expand leading ~ to home directory
  let expanded = inputPath.startsWith('~')
    ? os.homedir() + inputPath.slice(1)
    : inputPath;

  // Expand $VAR and ${VAR} — undefined vars expand to empty string (shell default)
  expanded = expanded.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, braced, bare) => {
    const name: string = braced ?? bare;
    return process.env[name] ?? '';
  });

  return expanded;
}

// ============================================================
// Public API
// ============================================================

/**
 * Safely resolve an input path relative to a workspace, applying:
 *   - UNC path rejection (prevents SMB DNS rebinding)
 *   - ~ and $VAR expansion
 *   - realpath on both input and workspace (D17: /var -> /private/var on macOS)
 *   - Workspace boundary check after realpath (prevents symlink escape)
 *
 * Throws UncPathError for UNC inputs.
 * Throws the native realpathSync error if the path does not exist.
 */
export function safeResolvePath(inputPath: string, workspace: string): ResolveResult {
  // 1. Reject UNC paths
  if (inputPath.startsWith('//') || inputPath.startsWith('\\\\')) {
    throw new UncPathError(inputPath);
  }

  // 2. Expand ~ and env vars
  const expanded = expandPath(inputPath);

  // 3. Resolve symlinks on the input path (throws if target does not exist)
  const resolvedPath = realpathSync(expanded);

  // 4. Resolve symlinks on the workspace (D17 fix, memoized)
  const realWs = realWorkspace(workspace);

  // 5. Workspace boundary check — the workspace directory itself counts as in-sandbox
  const inSandbox = resolvedPath === realWs || resolvedPath.startsWith(realWs + path.sep);

  return {
    resolvedPath,
    isSymlink: expanded !== resolvedPath,
    inSandbox,
  };
}
