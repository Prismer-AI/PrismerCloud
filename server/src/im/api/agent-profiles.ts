/**
 * Prismer IM — Agent Profiles API (v1.9.x Track A m1)
 *
 * AgentProfile = adapter-local config instance (cwd / model / MCP / env / prompt).
 * 1 IMUser (agent) → many AgentProfiles. What OpenClaw / Hermes call "workspace"
 * maps to this concept; do not confuse with IMWorkspace.
 *
 * See docs/refactor/02-workspace-data-model.md and docs/refactor/05-adapter-contract.md.
 *
 * Endpoints:
 *   GET    /agent_profiles?agentId=...   — list profiles for an agent
 *   POST   /agent_profiles               — create
 *   GET    /agent_profiles/sync          — daemon delta sync (?since=<ISO>)
 *   GET    /agent_profiles/:id
 *   PATCH  /agent_profiles/:id           — bumps version (optimistic lock)
 *   DELETE /agent_profiles/:id           — soft delete
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import { buildDefaultAcpProfileConfig, mergeMissingAcpProfileDefaults } from '../acp/profile-defaults';
import prisma from '../db';
import type { ApiResponse } from '../types/index';
import { ServerEvents } from '../ws/events';
import type { RoomManager } from '../ws/rooms';
// v2.0 BLOCKER 1 fix — daemon (hermes/openclaw adapter) reads /agent_profiles/:id
// raw config, NOT /agents/:id/spec. Inject Skill-first dynamically here too.
// v2.1 P0-4 — also surface the Chief-of-Staff pre-authorization clause when
// this agent is the workspace's active orchestrator. Without this, daemon
// dispatch loses the routine-task pre-authorization the spec endpoint grants.
import { appendChiefOfStaffClause, prependSkillFirstClauseIfMissing } from '../../lib/role-runtime-policy';
// release202/12 finding C2 — validate config.proxyProvider against the live
// provider-chain registry at write time so a typo'd / stale chain id (e.g.
// `deepsek`) can't be persisted verbatim. Without this, runtime resolveChain
// silently falls back to `default`, ignoring the user's explicit pick with no
// error and a UI that shows a chain that isn't really used. Layer note: `src/im`
// MAY import `src/lib` (eslint rule: src/im/ → src/lib/, src/types/).
import { getProviderChainIds, getProviderSources } from '../../lib/llm/provider-sources';

interface AgentProfileDTO {
  id: string;
  workspaceId: string;
  agentImUserId: string;
  agentUsername: string;
  adapterName: string;
  name: string;
  config: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

type AgentProfileRowWithAgent = {
  id: string;
  workspaceId: string;
  agentImUserId: string;
  adapterName: string;
  name: string;
  config: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

function toDTO(
  row: AgentProfileRowWithAgent,
  agentUsername: string,
  agentType?: string | null,
  isChiefOfStaff = false,
): AgentProfileDTO {
  let config: Record<string, unknown> = {};
  try {
    config = row.config ? JSON.parse(row.config) : {};
  } catch {
    config = {};
  }
  // v2.0 BLOCKER 1 — daemon-side adapter reads this DTO's config.operatingPrinciples
  // and feeds it to the LLM. Existing snapshotted profiles predate migration 422
  // (Skill-first block) so we inject the clause dynamically. Helper is idempotent
  // via string-search guard, so newer profiles already containing the block are
  // unaffected.
  // v2.1 P0-4 — same pattern for the Chief-of-Staff clause. The caller batch-
  // resolves which (workspace, agent) pair is the active orchestrator so we
  // do not issue a per-row im_workspaces lookup. isChiefOfStaff=false means
  // either the agent is not the appointed orchestrator OR the appointment was
  // revoked — both should hide the pre-authorization.
  const isOrchestrator = (agentType ?? '').toLowerCase() === 'orchestrator';
  const baseOp = config.operatingPrinciples;
  if (baseOp !== undefined && baseOp !== null) {
    let nextOp: unknown = prependSkillFirstClauseIfMissing(baseOp, isOrchestrator);
    if (isChiefOfStaff) {
      nextOp = appendChiefOfStaffClause(nextOp);
    }
    config = { ...config, operatingPrinciples: nextOp };
  }
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    agentImUserId: row.agentImUserId,
    agentUsername,
    adapterName: row.adapterName,
    name: row.name,
    config,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Batch-resolve agent usernames for a list of profile rows.
 * Returns a Map of agentImUserId → username (falls back to the id if not found).
 */
async function resolveAgentUsernames(agentImUserIds: string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(agentImUserIds));
  if (unique.length === 0) return new Map();
  const users = await prisma.iMUser.findMany({
    where: { id: { in: unique } },
    select: { id: true, username: true },
  });
  const map = new Map<string, string>();
  for (const u of users) map.set(u.id, u.username);
  // Fallback for any missing id → use the id itself (defensive; FK should guarantee existence)
  for (const id of unique) if (!map.has(id)) map.set(id, id);
  return map;
}

/**
 * v2.0 BLOCKER 1 — batch agentType for Skill-first injection in toDTO. The
 * helper picks the orchestrator (4-line) vs specialist (2-line) variant.
 */
async function resolveAgentTypes(agentImUserIds: string[]): Promise<Map<string, string | null>> {
  const unique = Array.from(new Set(agentImUserIds));
  if (unique.length === 0) return new Map();
  const users = await prisma.iMUser.findMany({
    where: { id: { in: unique } },
    select: { id: true, agentType: true },
  });
  const map = new Map<string, string | null>();
  for (const u of users) map.set(u.id, u.agentType ?? null);
  for (const id of unique) if (!map.has(id)) map.set(id, null);
  return map;
}

/**
 * v2.1 P0-4 — batch-resolve which (workspaceId, agentImUserId) pairs are the
 * active Chief-of-Staff for their workspace. One query over workspaces is
 * cheaper than N per-DTO lookups when GET /agent_profiles returns the full
 * agent set. The boolean must match `orchestratorAgentId IS NOT NULL AND
 * orchestratorRevokedAt IS NULL` so revoke takes effect on the next pull.
 *
 * Key shape: `${workspaceId}|${agentImUserId}` → true when this row should
 * carry the pre-authorization clause.
 */
async function resolveChiefOfStaffMap(rows: AgentProfileRowWithAgent[]): Promise<Map<string, boolean>> {
  const workspaceIds = Array.from(new Set(rows.map((r) => r.workspaceId)));
  if (workspaceIds.length === 0) return new Map();
  const workspaces = await prisma.iMWorkspace.findMany({
    where: { id: { in: workspaceIds }, deletedAt: null },
    select: { id: true, orchestratorAgentId: true, orchestratorRevokedAt: true },
  });
  const orchestratorByWorkspace = new Map<string, string | null>();
  for (const ws of workspaces) {
    orchestratorByWorkspace.set(
      ws.id,
      ws.orchestratorAgentId && ws.orchestratorRevokedAt === null ? ws.orchestratorAgentId : null,
    );
  }
  const out = new Map<string, boolean>();
  for (const row of rows) {
    const orchAgent = orchestratorByWorkspace.get(row.workspaceId) ?? null;
    out.set(`${row.workspaceId}|${row.agentImUserId}`, orchAgent === row.agentImUserId);
  }
  return out;
}

function chiefOfStaffKey(workspaceId: string, agentImUserId: string): string {
  return `${workspaceId}|${agentImUserId}`;
}

/**
 * Single-row lookup variant — used by POST / GET-by-id / PATCH where we don't
 * have a batch to amortise over.
 */
async function isChiefOfStaff(workspaceId: string, agentImUserId: string): Promise<boolean> {
  if (!workspaceId || !agentImUserId) return false;
  const ws = await prisma.iMWorkspace.findFirst({
    where: { id: workspaceId, deletedAt: null },
    select: { orchestratorAgentId: true, orchestratorRevokedAt: true },
  });
  if (!ws) return false;
  return ws.orchestratorAgentId === agentImUserId && ws.orchestratorRevokedAt === null;
}

/**
 * Verify the caller owns the workspace. Returns the workspace row on success,
 * or null if the workspace doesn't exist or doesn't belong to the caller.
 */
async function loadOwnedWorkspace(workspaceId: string, callerImUserId: string) {
  const ws = await prisma.iMWorkspace.findFirst({
    where: { id: workspaceId, deletedAt: null },
    select: { id: true, ownerImUserId: true },
  });
  if (!ws || ws.ownerImUserId !== callerImUserId) return null;
  return ws;
}

export function createAgentProfilesRouter(rooms?: RoomManager) {
  const router = new Hono();

  // eslint-disable-next-line custom/no-wildcard-sub-router-middleware -- mounted at /agent_profiles in routes.ts; wildcard scoped to that prefix
  router.use('*', authMiddleware);

  // GET /agent_profiles?agentId=...&workspaceId=...
  router.get('/', async (c) => {
    const user = c.get('user');
    const agentId = c.req.query('agentId');
    const workspaceId = c.req.query('workspaceId');
    if (!agentId && !workspaceId) {
      return c.json<ApiResponse>({ ok: false, error: 'agentId or workspaceId is required' }, 400);
    }

    if (workspaceId) {
      const ws = await loadOwnedWorkspace(workspaceId, user.imUserId);
      if (!ws) return c.json<ApiResponse>({ ok: false, error: 'Workspace not found' }, 404);
    }

    const rows = await prisma.iMAgentProfile.findMany({
      where: {
        deletedAt: null,
        ...(agentId ? { agentImUserId: agentId } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        // owner check via workspace join
        workspace: { ownerImUserId: user.imUserId, deletedAt: null },
      },
      orderBy: { updatedAt: 'desc' },
    });
    const agentIds = rows.map((r: AgentProfileRowWithAgent) => r.agentImUserId);
    const [usernameMap, agentTypeMap, chiefOfStaffMap] = await Promise.all([
      resolveAgentUsernames(agentIds),
      resolveAgentTypes(agentIds),
      resolveChiefOfStaffMap(rows),
    ]);
    return c.json<ApiResponse<AgentProfileDTO[]>>({
      ok: true,
      data: rows.map((r: AgentProfileRowWithAgent) =>
        toDTO(
          r,
          usernameMap.get(r.agentImUserId) ?? r.agentImUserId,
          agentTypeMap.get(r.agentImUserId),
          chiefOfStaffMap.get(chiefOfStaffKey(r.workspaceId, r.agentImUserId)) ?? false,
        ),
      ),
    });
  });

  // POST /agent_profiles
  router.post('/', async (c) => {
    const user = c.get('user');
    let body: {
      workspaceId?: string;
      agentImUserId?: string;
      adapterName?: string;
      name?: string;
      config?: Record<string, unknown>;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }

    const { workspaceId, agentImUserId, adapterName, name } = body;
    if (!workspaceId || !agentImUserId || !adapterName || !name) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: 'workspaceId, agentImUserId, adapterName, name are all required',
        },
        400,
      );
    }

    const ws = await loadOwnedWorkspace(workspaceId, user.imUserId);
    if (!ws) return c.json<ApiResponse>({ ok: false, error: 'Workspace not found' }, 404);

    // Hermes adapter: each agent must have its OWN profileDir / port /
    // SOUL.md / MCP env. Sharing them (the previous "force one apiKey across
    // workspace" hack) caused the SOUL.md race + the MCP-as-Tom senderId
    // bug — see MIGRATION-per-agent-profile.sql for the data migration that
    // backfilled existing rows. Now stamp per-agent defaults at create time:
    //   hermesProfileName = agent.username
    //   port              = 8642 + CRC32(username) % 1000 (deterministic, low collision)
    // Caller may still override either via body.config.
    let incomingConfig: Record<string, unknown> = { ...(body.config ?? {}) };
    if (adapterName === 'hermes' && agentImUserId) {
      const agentRow = await prisma.iMUser.findUnique({
        where: { id: agentImUserId },
        select: {
          username: true,
          displayName: true,
          agentType: true,
          agentCard: { select: { agentType: true, capabilities: true } },
        },
      });
      const needsProfileName =
        typeof incomingConfig.hermesProfileName !== 'string' ||
        incomingConfig.hermesProfileName === 'default' ||
        !incomingConfig.hermesProfileName;
      const needsPort = typeof incomingConfig.port !== 'number' || incomingConfig.port === 8642;
      if (agentRow?.username) {
        if (needsProfileName) incomingConfig.hermesProfileName = agentRow.username;
        if (needsPort) {
          // Stable per-username hash → 8642..9641
          let h = 0;
          for (let i = 0; i < agentRow.username.length; i++) {
            h = (h * 31 + agentRow.username.charCodeAt(i)) | 0;
          }
          incomingConfig.port = 8642 + (Math.abs(h) % 1000);
        }
      }
      incomingConfig = mergeMissingAcpProfileDefaults(
        incomingConfig,
        buildDefaultAcpProfileConfig({
          username: agentRow?.username,
          displayName: agentRow?.displayName,
          agentType: agentRow?.agentType || agentRow?.agentCard?.agentType,
          capabilities: parseCapabilities(agentRow?.agentCard?.capabilities),
        }),
      );
    }

    // release202/12 C2 — reject typo'd / stale provider-chain ids at write time.
    const proxyProviderError = validateProxyProvider(incomingConfig);
    if (proxyProviderError) {
      return c.json<ApiResponse>(
        { ok: false, error: { code: 'invalid_proxy_provider', message: proxyProviderError } },
        400,
      );
    }

    try {
      const created = await prisma.iMAgentProfile.create({
        data: {
          workspaceId,
          agentImUserId,
          adapterName,
          name,
          config: JSON.stringify(incomingConfig),
        },
      });
      rooms?.sendToUser(
        user.imUserId,
        ServerEvents.agentProfileChanged({ profileId: created.id, version: created.version }),
      );
      const agent = await prisma.iMUser.findUnique({
        where: { id: created.agentImUserId },
        select: { username: true, agentType: true },
      });
      const cosFlag = await isChiefOfStaff(created.workspaceId, created.agentImUserId);
      return c.json<ApiResponse<AgentProfileDTO>>(
        { ok: true, data: toDTO(created, agent?.username ?? created.agentImUserId, agent?.agentType, cosFlag) },
        201,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Unique') || msg.includes('UNIQUE')) {
        return c.json<ApiResponse>(
          { ok: false, error: 'A profile with this name already exists for this agent in this workspace' },
          409,
        );
      }
      return c.json<ApiResponse>({ ok: false, error: msg }, 500);
    }
  });

  // GET /agent_profiles/sync — daemon delta sync (registered before /:id)
  router.get('/sync', async (c) => {
    const user = c.get('user');
    const sinceParam = c.req.query('since');
    const sinceDate = sinceParam ? new Date(sinceParam) : null;
    if (sinceParam && (!sinceDate || isNaN(sinceDate.getTime()))) {
      return c.json<ApiResponse>({ ok: false, error: 'since must be a valid ISO timestamp' }, 400);
    }
    const rows = await prisma.iMAgentProfile.findMany({
      where: {
        workspace: { ownerImUserId: user.imUserId, deletedAt: null },
        ...(sinceDate ? { updatedAt: { gt: sinceDate } } : {}),
      },
      orderBy: { updatedAt: 'asc' },
    });
    const cursor = rows.length > 0 ? rows[rows.length - 1].updatedAt.toISOString() : (sinceParam ?? null);
    const agentIds = rows.map((r: AgentProfileRowWithAgent) => r.agentImUserId);
    const [usernameMap, agentTypeMap, chiefOfStaffMap] = await Promise.all([
      resolveAgentUsernames(agentIds),
      resolveAgentTypes(agentIds),
      resolveChiefOfStaffMap(rows),
    ]);
    return c.json<ApiResponse<{ items: AgentProfileDTO[]; cursor: string | null }>>({
      ok: true,
      data: {
        items: rows.map((r: AgentProfileRowWithAgent) =>
          toDTO(
            r,
            usernameMap.get(r.agentImUserId) ?? r.agentImUserId,
            agentTypeMap.get(r.agentImUserId),
            chiefOfStaffMap.get(chiefOfStaffKey(r.workspaceId, r.agentImUserId)) ?? false,
          ),
        ),
        cursor,
      },
    });
  });

  // GET /agent_profiles/:id
  router.get('/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const row = await prisma.iMAgentProfile.findFirst({
      where: { id, deletedAt: null, workspace: { ownerImUserId: user.imUserId } },
    });
    if (!row) return c.json<ApiResponse>({ ok: false, error: 'Profile not found' }, 404);
    const [agent, cosFlag] = await Promise.all([
      prisma.iMUser.findUnique({
        where: { id: row.agentImUserId },
        select: { username: true, agentType: true },
      }),
      isChiefOfStaff(row.workspaceId, row.agentImUserId),
    ]);
    return c.json<ApiResponse<AgentProfileDTO>>({
      ok: true,
      data: toDTO(row, agent?.username ?? row.agentImUserId, agent?.agentType, cosFlag),
    });
  });

  // PATCH /agent_profiles/:id
  router.patch('/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const row = await prisma.iMAgentProfile.findFirst({
      where: { id, deletedAt: null, workspace: { ownerImUserId: user.imUserId } },
    });
    if (!row) return c.json<ApiResponse>({ ok: false, error: 'Profile not found' }, 404);

    let body: {
      name?: string;
      config?: Record<string, unknown>;
      version?: number; // optional optimistic-lock guard
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }

    if (typeof body.version === 'number' && body.version !== row.version) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: { code: 'version_conflict', message: `Profile is at version ${row.version}` },
          meta: { currentVersion: row.version },
        },
        409,
      );
    }

    // release202/12 C2 — reject typo'd / stale provider-chain ids at write time.
    if (body.config && typeof body.config === 'object') {
      const proxyProviderError = validateProxyProvider(body.config);
      if (proxyProviderError) {
        return c.json<ApiResponse>(
          { ok: false, error: { code: 'invalid_proxy_provider', message: proxyProviderError } },
          400,
        );
      }
    }

    const data: Record<string, unknown> = { version: { increment: 1 } };
    if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim();
    if (body.config && typeof body.config === 'object') data.config = JSON.stringify(body.config);
    if (Object.keys(data).length === 1) {
      // only version increment with no other fields → reject
      return c.json<ApiResponse>({ ok: false, error: 'No updatable fields supplied' }, 400);
    }

    const updated = await prisma.iMAgentProfile.update({ where: { id }, data });
    rooms?.sendToUser(
      user.imUserId,
      ServerEvents.agentProfileChanged({ profileId: updated.id, version: updated.version }),
    );
    const [agent, cosFlag] = await Promise.all([
      prisma.iMUser.findUnique({
        where: { id: updated.agentImUserId },
        select: { username: true, agentType: true },
      }),
      isChiefOfStaff(updated.workspaceId, updated.agentImUserId),
    ]);
    return c.json<ApiResponse<AgentProfileDTO>>({
      ok: true,
      data: toDTO(updated, agent?.username ?? updated.agentImUserId, agent?.agentType, cosFlag),
    });
  });

  // DELETE /agent_profiles/:id — soft delete
  router.delete('/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const row = await prisma.iMAgentProfile.findFirst({
      where: { id, deletedAt: null, workspace: { ownerImUserId: user.imUserId } },
    });
    if (!row) return c.json<ApiResponse>({ ok: false, error: 'Profile not found' }, 404);
    const deleted = await prisma.iMAgentProfile.update({
      where: { id },
      data: { deletedAt: new Date(), version: { increment: 1 } },
    });
    rooms?.sendToUser(
      user.imUserId,
      ServerEvents.agentProfileChanged({ profileId: deleted.id, version: deleted.version }),
    );
    return c.json<ApiResponse>({ ok: true });
  });

  return router;
}

/**
 * release202/12 finding C2 — validate a profile config's `proxyProvider`.
 *
 * Returns an error message string when the value is a non-empty string that is
 * NOT a known provider-chain id; returns `null` (no error) when it is valid OR
 * when `proxyProvider` is absent/empty (absent ⇒ leave behavior unchanged, the
 * runtime falls back to the `default` chain by design). Only `proxyProvider` is
 * gated here — `model` is intentionally NOT validated because the runtime
 * `modelForSource` guard coerces an unservable model, so model validation is
 * low-value and could wrongly reject a perfectly serviceable request.
 */
export function validateProxyProvider(config: unknown): string | null {
  if (!config || typeof config !== 'object') return null;
  const proxyProvider = (config as Record<string, unknown>).proxyProvider;
  if (proxyProvider === undefined || proxyProvider === null || proxyProvider === '') return null;
  if (typeof proxyProvider !== 'string') {
    return `config.proxyProvider must be a string (got ${typeof proxyProvider})`;
  }
  // Mirror the proxy route's `isKnownProvider` (chat/completions/[provider]):
  // a value is valid if it is a registered chain id OR a bare source id (the
  // proxy resolves a lone source id to a single-element chain). Validating
  // ONLY chain ids would wrongly reject a profile the proxy would happily serve.
  const knownChains = getProviderChainIds();
  const isKnown =
    knownChains.includes(proxyProvider) || getProviderSources().some((s) => s.id === proxyProvider);
  if (!isKnown) {
    return `Unknown provider chain/source id "${proxyProvider}". Known chains: ${knownChains.join(', ')}`;
  }
  return null;
}

function parseCapabilities(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}
