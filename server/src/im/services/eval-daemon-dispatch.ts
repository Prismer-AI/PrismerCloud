/**
 * Eval daemon dispatch — release201/24 §3.
 *
 * Composition-root helper that lets `SkillLifecycleService.startEvalRun`
 * push a queued eval run to the owner agent's bound daemon over the WS
 * reverse channel (the same transport `agent-dispatcher` uses for webhook
 * dispatch). The daemon acks via `skill.eval.reply` and runs the skill in an
 * isolated HOME, POSTing per-case results back to
 * `/api/im/skills/:id/eval/runs/:runId/finish`.
 *
 * When the owner agent has no bound daemon, the daemon is offline, or the
 * ack times out, the dispatcher returns `{ accepted: false }` and the
 * lifecycle service stamps the run `queued_no_runner` — never a fake pass.
 */

import prisma from '../db';
import type { RoomManager } from '../ws/rooms';
import type { WsRpcService } from './ws-rpc.service';
import type { EvalDaemonDispatch } from './skill-lifecycle.service';

function daemonRouteKey(daemonId: string): string {
  return `daemon:${daemonId}`;
}

export function createEvalDaemonDispatch(deps: {
  rooms: Pick<RoomManager, 'getClientConnections'>;
  wsRpc: Pick<WsRpcService, 'invoke'>;
}): EvalDaemonDispatch {
  return async (req) => {
    if (!req.ownerAgentId) {
      return { accepted: false, reason: 'skill has no ownerAgentId' };
    }

    const binding = await (prisma as any).iMAgentBinding
      .findUnique({ where: { agentImUserId: req.ownerAgentId } })
      .catch(() => null);
    const daemonId: string | undefined = binding?.boundDaemonId;
    if (!daemonId) {
      return { accepted: false, reason: 'owner agent has no bound daemon' };
    }

    const routeKey = daemonRouteKey(daemonId);
    if (deps.rooms.getClientConnections(routeKey).size === 0) {
      return { accepted: false, daemonId, reason: 'daemon offline' };
    }

    const res = await deps.wsRpc.invoke(
      routeKey,
      'skill.eval.request',
      {
        runId: req.runId,
        skillId: req.skillId,
        skillSlug: req.skillSlug,
        skillManifest: req.skillManifest,
        allowlistBuiltins: req.allowlistBuiltins,
        testCases: req.testCases,
      },
      { timeoutMs: 15_000 },
    );

    if (res.ok) {
      return { accepted: true, daemonId };
    }
    return { accepted: false, daemonId, reason: res.error.kind };
  };
}
