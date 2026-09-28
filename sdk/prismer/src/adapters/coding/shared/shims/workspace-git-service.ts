// WS-B (PP-1) — minimal type shim for Paseo's workspace-git-service.
//
// provider-registry and codex-app-server-agent reference WorkspaceGitService
// only as `Pick<WorkspaceGitService, "resolveRepoRoot">` (a type). The full git
// service (worktrees, remotes, metadata) lives in the daemon and is a B2
// concern. Only the consumed method is declared here.
//
// See docs/release203/08-paseo-port-unified-agent-engine.md §7.7 WS-B.
export interface WorkspaceGitReadOptions {
  [key: string]: unknown;
}

export interface WorkspaceGitService {
  resolveRepoRoot(cwd: string, options?: WorkspaceGitReadOptions): Promise<string>;
}
