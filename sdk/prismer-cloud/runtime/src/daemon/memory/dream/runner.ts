// Cloud-runner: posts to /api/im/memory/page-dream — M-C (doc 25 §3 支柱 3).
//
// The daemon scheduler delegates the actual three-invariant work to the
// cloud (which owns the IMMemoryPage tables). This module is the
// thin HTTP client that bridges scheduler ticks to the cloud endpoint.

import type { CloudClient } from '../../../auth.js';
import type { DreamRunner } from './scheduler.js';

export interface CloudDreamRunnerOptions {
  cloud: CloudClient;
  /** Optional override for the agent id stamped on garbage-prune
   *  proposals. Defaults to "__dream_daemon__" — cloud accepts any
   *  string and the proposal review UI should render it as "system". */
  sessionAgentId?: string | null;
}

export class CloudDreamRunner implements DreamRunner {
  constructor(private readonly opts: CloudDreamRunnerOptions) {}

  async run(workspaceId: string): Promise<void> {
    const body: { workspaceId: string; sessionAgentId?: string } = { workspaceId };
    if (this.opts.sessionAgentId) body.sessionAgentId = this.opts.sessionAgentId;
    const res = await this.opts.cloud.request('POST', '/memory/page-dream', { body });
    if (!res.ok) {
      throw new Error(`page-dream HTTP ${res.status} code=${res.error?.code ?? 'unknown'}`);
    }
    // Body returned but the scheduler doesn't care about details — the
    // cloud writes proposals + observability events on its side, and
    // those flow back via the existing inbox/outbox channels.
  }
}
