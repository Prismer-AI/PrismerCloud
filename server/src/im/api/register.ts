/**
 * Prismer IM — Agent Self-Registration & Token Management
 *
 * Agents register autonomously with just an API Key.
 * Humans are auto-registered on first API Key usage (no explicit call needed).
 *
 * POST /api/im/register    — Register Agent/Human identity
 * POST /api/im/token/refresh — Refresh JWT token
 */

import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import type Redis from 'ioredis';
import { authMiddleware, cloudOwnerWhere } from '../auth/middleware';
import { signToken, verifyToken, decodeToken } from '../auth/jwt';
import prisma from '../db';
import type { ApiResponse, RegisterInput, RegisterResult } from '../types/index';
import { generateIMUserId } from '../utils/id-gen';
import type { EvolutionService } from '../services/evolution.service';
import type { RateLimiterService } from '../services/rate-limiter.service';
import { createRateLimitMiddleware } from '../middleware/rate-limit';
import { createModuleLogger } from '@/lib/logger';
import { AgentSkillService } from '../services/agent-skill.service';
import { BuiltInSkillService } from '../services/built-in-skill.service';
import { SkillService } from '../services/skill.service';

const registerLog = createModuleLogger('register');

const USERNAME_REGEX = /^[a-zA-Z0-9_-]{3,32}$/;

/**
 * Optional auth middleware — sets user if valid token present, skips if not.
 *
 * For API Key proxy tokens: stores cloudUserId (does NOT auto-create IM user).
 * For direct JWT tokens: stores imUserId as before.
 */
async function optionalAuthMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    // No auth — proceed without user (anonymous registration)
    await next();
    return;
  }

  // Try to verify token
  const token = authHeader.slice(7);
  try {
    const payload = verifyToken(token);

    if (payload.type === 'api_key_proxy') {
      // API Key proxy: store cloudUserId for multi-agent lookup in handler
      c.set('user', { ...payload, cloudUserId: payload.sub } as any);
    } else {
      // Direct JWT: sub is already IM User ID
      c.set('user', { ...payload, imUserId: payload.sub } as any);
    }
  } catch {
    // Invalid token — proceed as anonymous
  }
  await next();
}

export function createRegisterRouter(
  evolutionService?: EvolutionService,
  rateLimiter?: RateLimiterService,
  redis?: Redis,
) {
  const router = new Hono();

  /**
   * POST /register — Agent/Human self-registration
   *
   * Auth is optional:
   * - With API Key: agent bound to human, credits from human's pool
   * - Without auth: anonymous self-registration, agent gets 100000 credits (≈100M messages)
   */
  router.use('/register', optionalAuthMiddleware);
  if (rateLimiter) {
    router.post('/register', createRateLimitMiddleware(rateLimiter, 'agent.register'));
  }
  router.post('/register', async (c) => {
    const user = c.get('user') as any | undefined;

    let body: RegisterInput;
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }

    const {
      type,
      username,
      displayName,
      agentType,
      workspaceId: requestedWorkspaceId,
      capabilities,
      description,
      endpoint,
      webhookSecret,
      metadata: inputMetadata,
    } = body;

    // Validate type
    if (!type || !['agent', 'human'].includes(type)) {
      return c.json<ApiResponse>({ ok: false, error: 'type must be "agent" or "human"' }, 400);
    }

    // Validate username
    if (!username) {
      return c.json<ApiResponse>({ ok: false, error: 'username is required' }, 400);
    }
    if (!USERNAME_REGEX.test(username)) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: 'username must be 3-32 characters, alphanumeric, underscore, or hyphen',
        },
        400,
      );
    }

    // Validate displayName
    if (!displayName) {
      return c.json<ApiResponse>({ ok: false, error: 'displayName is required' }, 400);
    }

    // Validate agentType for agents
    const validAgentTypes = ['assistant', 'specialist', 'orchestrator', 'tool', 'bot'];
    if (type === 'agent' && agentType && !validAgentTypes.includes(agentType)) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: `agentType must be one of: ${validAgentTypes.join(', ')}`,
        },
        400,
      );
    }
    if (requestedWorkspaceId !== undefined && typeof requestedWorkspaceId !== 'string') {
      return c.json<ApiResponse>({ ok: false, error: 'workspaceId must be a string' }, 400);
    }

    // Find existing user:
    // - API Key (cloudUserId): look up by (cloudUserId, username) — allows multi-agent
    // - Direct JWT (imUserId): look up by IM User ID
    // - Anonymous: look up by username only
    const cloudUserId = user?.cloudUserId as string | undefined;
    let existingUser: any = null;

    if (cloudUserId) {
      // API Key user: find agent with same (cloudUserId, username)
      existingUser = await prisma.iMUser.findFirst({
        // numericId-aware owner match (release202/08) — api-key cloudUserId is
        // often im_users.numericId, not the backfilled userId string.
        where: { username, OR: cloudOwnerWhere(cloudUserId) },
        // deterministic pick if the numericId-aware OR ever matches >1 row
        orderBy: { createdAt: 'asc' },
        include: { agentCard: true },
      });
    } else if (user?.imUserId) {
      // Direct JWT user: find by IM User ID. For a human registering an
      // *agent* (Wave-4 cookbook + IM-only flows), the JWT-subject row is
      // the human owner — registering an agent should NOT collapse the
      // human into role=agent. Skip the lookup so the create-new branch
      // owns the new agent IMUser; the human stays as-is.
      const jwtSelf = await prisma.iMUser.findUnique({
        where: { id: user.imUserId },
        include: { agentCard: true },
      });
      const jwtSelfIsHuman = jwtSelf?.role === 'human';
      const registeringAgent = type === 'agent';
      if (jwtSelfIsHuman && registeringAgent) {
        // Leave existingUser=null → fall through to create-new path so the
        // human gets a sibling agent record with their own cloudUserId-style
        // ownership. resolveOwnerWorkspaceId() will resolve the human as
        // owner via user.imUserId.
        existingUser = null;
      } else {
        existingUser = jwtSelf;
      }
    }

    // Check username uniqueness within target workspace (per-workspace scope).
    //
    // §30 Q2 (post-decision): slug = im_users.username is GLOBALLY UNIQUE
    // (single-column UNIQUE index). Two paths previously diverged here:
    //   1. direct JWT path → 409 (strict, correct)
    //   2. API Key (cloudUserId) bypass → silently rebound the existing
    //      agent's AgentCard to the new workspaceId. Net effect: an agent
    //      could be moved from workspace A to workspace B without anyone
    //      noticing. That was wrong by both the documented spec ("unique
    //      across the platform") and the user-decided behavior ("global
    //      uniqueness; reject cross-workspace reuse explicitly").
    //
    // The fix preserves the legitimate same-workspace update case (caller
    // re-registers their own agent in its current workspace — that's the
    // update path AgentCard upserts were designed for) but returns 409
    // USERNAME_TAKEN_IN_OTHER_WORKSPACE when the existing agent lives in
    // a DIFFERENT workspace from the one the current call is registering
    // into. Workspace resolution mirrors the create path: explicit
    // requestedWorkspaceId wins; otherwise the holder's own AgentCard
    // workspaceId is the implicit target (matches update-path behavior
    // at line ~428: `requestedWorkspaceId || existingUser.agentCard.workspaceId`).
    // Per-workspace lookup: find agent card in the target workspace by username.
    // im_users.username no longer has a UNIQUE constraint (v1.9.0+ migration 324).
    const targetWsId = requestedWorkspaceId ?? existingUser?.agentCard?.workspaceId;
    let usernameHolder: {
      id: string;
      userId: string | null;
      numericId: bigint | number | null;
      agentCard: { workspaceId: string } | null;
    } | null = null;
    if (targetWsId) {
      const cardInWs = await prisma.iMAgentCard.findFirst({
        where: { workspaceId: targetWsId, imUser: { username } },
        select: { imUserId: true, workspaceId: true, imUser: { select: { id: true, userId: true, numericId: true } } },
      });
      if (cardInWs) {
        usernameHolder = {
          id: cardInWs.imUser.id,
          userId: cardInWs.imUser.userId,
          numericId: cardInWs.imUser.numericId,
          agentCard: { workspaceId: cardInWs.workspaceId },
        };
      }
    } else {
      // No workspace context — fallback to global lookup (human registration path).
      const user = await prisma.iMUser.findFirst({ where: { username }, include: { agentCard: true } });
      if (user)
        usernameHolder = {
          id: user.id,
          userId: user.userId,
          numericId: user.numericId,
          agentCard: user.agentCard ? { workspaceId: user.agentCard.workspaceId } : null,
        };
    }
    if (usernameHolder) {
      const isOwnUser = existingUser && usernameHolder.id === existingUser.id;
      // numericId-aware (same bug class as the owner lookups): cloudUserId is
      // often im_users.numericId, so match userId OR numericId.
      const isOwnCloudUser =
        !!cloudUserId &&
        (usernameHolder.userId === cloudUserId ||
          (usernameHolder.numericId != null && String(usernameHolder.numericId) === cloudUserId));
      if (!isOwnUser && !isOwnCloudUser) {
        return c.json<ApiResponse>(
          {
            ok: false,
            error: `Username '${username}' is already taken`,
          },
          409,
        );
      }
      // §30 Q2 cross-workspace guard — applies to the API-Key bypass path.
      // If the caller owns this slug already (isOwnCloudUser) but the
      // existing AgentCard is in a different workspace than the one being
      // registered into, reject with a distinct error code so callers can
      // surface "this slug is yours, but it lives in another workspace —
      // pick a different one" UI without conflating with the generic
      // "taken by someone else" message.
      if (targetWsId && isOwnCloudUser && usernameHolder.agentCard?.workspaceId) {
        if (usernameHolder.agentCard.workspaceId !== targetWsId) {
          return c.json<ApiResponse>(
            {
              ok: false,
              error: {
                code: 'USERNAME_TAKEN_IN_OTHER_WORKSPACE',
                message: `Username '${username}' is already used by your agent in another workspace. Choose a different slug.`,
              },
            },
            409,
          );
        }
      }
      // If username is held by same cloud user but different agent, allow (it's updating)
      if (isOwnCloudUser && !existingUser) {
        existingUser = await prisma.iMUser.findUnique({
          where: { id: usernameHolder.id },
          include: { agentCard: true },
        });
      }
    }

    let isNew = false;
    let imUserId: string;
    let ownerUserId: string | null = null;
    let ownerNumericId: bigint | number | null = null;

    // Build agent metadata: merge caller-provided metadata + webhookSecret
    const buildMetadata = (existing?: string | null) => {
      const base = existing ? JSON.parse(existing) : {};
      if (inputMetadata && typeof inputMetadata === 'object') {
        Object.assign(base, inputMetadata);
      }
      if (webhookSecret !== undefined) base.webhookSecret = webhookSecret;
      return JSON.stringify(base);
    };

    async function assertRequestedDaemonBelongsToWorkspace(workspaceId: string): Promise<Response | null> {
      if (!redis || !inputMetadata || typeof inputMetadata !== 'object') return null;
      const daemonId = (inputMetadata as { daemonId?: unknown }).daemonId;
      if (typeof daemonId !== 'string' || !daemonId.trim()) return null;
      const key = `runtime:device:${workspaceId}:${daemonId.trim()}`;
      const raw = await redis.get(key).catch(() => null);
      if (!raw) {
        return c.json<ApiResponse>(
          {
            ok: false,
            error: `Daemon ${daemonId} is not connected to workspace ${workspaceId}`,
          },
          409,
        );
      }
      return null;
    }

    /**
     * §30 §2.6 device capacity model — enforce per-device agent ceiling.
     *
     * Resolves the IMContainer (device) row from the requested daemonId,
     * counts agents currently bound to that daemon (via IMAgentCard
     * metadata.daemonId), and rejects with HTTP 409 + body
     * `{ error: { code: 'CAPACITY_EXCEEDED', message }, used, max }` when
     * the existing-agent count has reached `im_containers.maxAgents`.
     *
     * No-op when:
     *   • caller did not declare a daemonId (`inputMetadata.daemonId` absent)
     *   • the daemonId does not resolve to any IMContainer row (unbound /
     *     synthetic daemon — capacity ceiling is a per-device concept, so
     *     there is nothing to enforce against). The earlier Redis check
     *     ensures the daemon is at least connected to the workspace.
     *   • the registering agent already owns a card on this daemon (update
     *     path — counts the existing slot, so re-registering itself never
     *     trips the ceiling).
     */
    /**
     * Normalize a daemonId to its bare runtime-instance form (strip the
     * `container:` prefix once if present). Used to compare caller-supplied
     * daemonId against card.metadata.daemonId — callers historically vary
     * on whether they include the prefix, so equality must be prefix-agnostic.
     * Returns null when input is not a non-empty string.
     */
    function normalizeDaemonId(value: unknown): string | null {
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      if (!trimmed) return null;
      return trimmed.startsWith('container:') ? trimmed.slice('container:'.length) : trimmed;
    }

    async function assertDeviceCapacityAvailable(
      workspaceId: string,
      registeringImUserId: string | null,
    ): Promise<Response | null> {
      if (!inputMetadata || typeof inputMetadata !== 'object') return null;
      const rawDaemonId = (inputMetadata as { daemonId?: unknown }).daemonId;
      // No daemonId declared → no device-scoped ceiling to enforce. CLI / lightweight
      // agents that don't claim a daemon stay on the legacy unbounded path.
      if (typeof rawDaemonId !== 'string' || !rawDaemonId.trim()) return null;
      const daemonId = rawDaemonId.trim();

      // daemonId pattern emitted by runtime-installations: `container:<runtimeInstanceId>`
      // where runtimeInstanceId === IMContainer.agentImUserId. We accept both
      // the prefixed form and the bare form (heartbeats / older callers).
      const runtimeInstanceId = normalizeDaemonId(daemonId);
      if (!runtimeInstanceId) return null;

      // Match by agentImUserId (runtime-installation path, short ID) OR by
      // daemonId (the full daemon ID from WS host.declare). The daemonId
      // column is varchar(64) — long enough for the full UUID-format daemon
      // ID. Using OR lets local daemons (which only have a Redis presence and
      // a dynamically-upserted container row) be found without changing the
      // runtime-installation lookup.
      const device = (await prisma.iMContainer.findFirst({
        where: { workspaceId, OR: [{ agentImUserId: runtimeInstanceId }, { daemonId }] },
        select: { id: true, maxAgents: true },
      })) as { id: string; maxAgents: number | null } | null;

      // §M1 — fail-closed for unknown daemon. If the caller explicitly declared
      // a daemonId but no IMContainer row matches in this workspace, we must
      // NOT silently fall through to "no ceiling". An attacker who can connect
      // their forged daemon to workspace Redis would otherwise be able to mint
      // unlimited agents by pointing at a daemonId that has no device row.
      // (No-op only when daemonId was absent from input — handled above.)
      if (!device) {
        return c.json<ApiResponse>(
          {
            ok: false,
            error: {
              code: 'UNKNOWN_DAEMON',
              message: `Daemon ${daemonId} is not registered as a device in workspace ${workspaceId}; cannot enforce capacity.`,
            },
          },
          409,
        );
      }

      // §M2 — fallback observability. im_containers.maxAgents is supposed to
      // be NOT NULL with DEFAULT 3 since migration 323. If a row predates the
      // migration (or someone NULLed it manually) we still want to enforce a
      // safe ceiling, but operators should know. Log once per call when this
      // fallback triggers so the gap shows up in central log search.
      if (device.maxAgents == null) {
        registerLog.warn(
          {
            deviceId: device.id,
            workspaceId,
            daemonId,
            runtimeInstanceId,
            message: 'im_containers.maxAgents missing — fallback 10; check migration 323/340',
          },
          'maxAgents fallback used',
        );
      }
      const max = device.maxAgents ?? 10;

      // Count agents already bound to this daemon. metadata is a JSON-encoded
      // string column on im_agent_cards; parse client-side to stay portable.
      const cards = (await prisma.iMAgentCard.findMany({
        where: { workspaceId },
        select: { imUserId: true, metadata: true },
      })) as Array<{ imUserId: string; metadata: string | null }>;

      let used = 0;
      let registeringAlreadyBound = false;
      for (const card of cards) {
        let cardDaemonId: string | null = null;
        let metadataParseFailed = false;
        try {
          const meta = JSON.parse(card.metadata || '{}') as { daemonId?: unknown };
          cardDaemonId = normalizeDaemonId(meta.daemonId);
        } catch {
          metadataParseFailed = true;
        }

        if (metadataParseFailed) {
          // §n4 — fail-closed for malformed metadata. A card with garbled
          // JSON could be a regression, a half-written upgrade, or an
          // intentional bypass attempt. Conservatively assume it occupies
          // a slot on this daemon so the ceiling can't be evaded by
          // corrupting metadata. Log the imUserId so operators can audit.
          registerLog.error(
            {
              imUserId: card.imUserId,
              workspaceId,
              daemonId,
              message: 'im_agent_cards.metadata JSON parse failed — counting card toward capacity (fail-closed)',
            },
            'malformed agent card metadata',
          );
          used += 1;
          if (registeringImUserId && card.imUserId === registeringImUserId) {
            registeringAlreadyBound = true;
          }
          continue;
        }

        // §n1 — both sides normalized to bare runtime-instance form so that
        // `container:rt-001` vs `rt-001` (or vice-versa) compare equal.
        if (cardDaemonId !== runtimeInstanceId) continue;
        used += 1;
        if (registeringImUserId && card.imUserId === registeringImUserId) {
          registeringAlreadyBound = true;
        }
      }

      // If the registering user already holds a slot on this daemon, the
      // re-registration is in-place (not a new slot) and should not be
      // capacity-blocked. Otherwise the effective post-write count would be
      // `used + 1` for a new agent.
      const effectiveUsed = registeringAlreadyBound ? used : used + 1;
      if (effectiveUsed <= max) return null;

      return c.json<ApiResponse>(
        {
          ok: false,
          error: {
            code: 'CAPACITY_EXCEEDED',
            message: `Device ${daemonId} already hosts ${used} agent(s); maximum is ${max}.`,
          },
          // Surface `used` (current count) and `max` at the top-level meta so
          // callers can render a precise "N/M agents" UI without parsing the
          // message. ApiResponse.meta is the canonical place for non-`data`
          // structured response fields.
          meta: { used, max },
        },
        409,
      );
    }

    // v1.9.3: im_agent_cards.workspaceId is NOT NULL. Resolve the owning
    // workspace once for the agent-creation paths below. Falls back to creating
    // a default 'Personal' workspace if the owner has none yet (covers fresh
    // dev cloud where backfill-workspaces.ts hasn't run for newly-auth'd users).
    async function resolveOwnerWorkspaceId(): Promise<
      { ok: true; workspaceId: string } | { ok: false; error: string }
    > {
      // Find the human IMUser owning this cloud account.
      let owner: { id: string; userId?: string | null; numericId?: bigint | number | null };
      if (cloudUserId) {
        const humanOwner = await prisma.iMUser.findFirst({
          where: { role: 'human', OR: cloudOwnerWhere(cloudUserId) },
          select: { id: true, userId: true, numericId: true },
          orderBy: { createdAt: 'asc' },
        });
        if (!humanOwner) {
          return { ok: false, error: 'No human owner IMUser found for cloud user' };
        }
        owner = humanOwner;
      } else if (user?.imUserId) {
        // Direct JWT path: caller is the IM user themselves
        const selfOwner = await prisma.iMUser.findUnique({
          where: { id: user.imUserId },
          select: { id: true, userId: true, numericId: true },
        });
        if (!selfOwner) {
          return { ok: false, error: 'No owner IMUser found for direct JWT user' };
        }
        owner = selfOwner;
      } else {
        // No human owner record yet — agent registration without prior /me call.
        // Create a placeholder human owner first.
        if (!cloudUserId) {
          return { ok: false, error: 'No owner IMUser found and no cloudUserId to derive one' };
        }
        const ownerUsername = `user-${cloudUserId.slice(0, 8)}`;
        const existingOwner = await prisma.iMUser.findFirst({
          where: { username: ownerUsername },
          select: { id: true, userId: true, numericId: true },
        });
        owner =
          existingOwner ??
          (await prisma.iMUser.create({
            data: {
              id: generateIMUserId('human'),
              username: ownerUsername,
              displayName: ownerUsername,
              role: 'human',
              userId: cloudUserId,
            },
            select: { id: true, userId: true, numericId: true },
          }));
      }
      ownerUserId = owner.userId ?? null;
      ownerNumericId = owner.numericId ?? null;
      const ownerId: string = owner.id;
      if (requestedWorkspaceId) {
        const requested = await prisma.iMWorkspace.findFirst({
          where: { id: requestedWorkspaceId, ownerImUserId: ownerId, deletedAt: null },
          select: { id: true },
        });
        if (!requested) {
          return { ok: false, error: 'Requested workspace not found for owner' };
        }
        return { ok: true, workspaceId: requested.id };
      }
      const existing = await prisma.iMWorkspace.findFirst({
        where: { ownerImUserId: ownerId, isDefault: true, deletedAt: null },
        select: { id: true },
      });
      if (existing) return { ok: true, workspaceId: existing.id };
      // Don't set id — IMWorkspace uses Prisma @default(cuid()) (25 chars,
      // fits VARCHAR(30)). randomUUID() is 36 chars and overflows.
      // Bug Z1.b (v2.0.7 R3.E cookbook real-run): workspace + owner 的
      // im_workspace_members 行必须同事务写入，否则 owner GET
      // /workspaces/<id>/members 返 [] / 404，POST /tasks 被
      // task-permission.ts NotWorkspaceMemberError 拒 (403)。mirror Z1
      // (auth/middleware.ts:60 ensureDefaultWorkspace) 的同款 $transaction。
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- interactive tx client typing matches workspace-member.service pattern
      const ws = await prisma.$transaction(async (tx: any) => {
        const newWs = await tx.iMWorkspace.create({
          data: {
            ownerImUserId: ownerId,
            name: 'Personal',
            slug: 'personal',
            isDefault: true,
          },
          select: { id: true },
        });
        await tx.iMWorkspaceMember.create({
          data: {
            workspaceId: newWs.id,
            memberImUserId: ownerId,
            role: 'owner',
          },
        });
        return newWs;
      });
      return { ok: true, workspaceId: ws.id };
    }
    let resolvedWorkspaceId: string | undefined;

    async function ensureOwnerWorkspaceId(): Promise<string | Response> {
      const resolved = await resolveOwnerWorkspaceId();
      if (!resolved.ok) {
        return c.json<ApiResponse>({ ok: false, error: resolved.error }, 404);
      }
      return resolved.workspaceId;
    }

    if (existingUser) {
      // §① — All preconditions (cross-workspace guard, daemon-belongs-to-ws,
      // device capacity ceiling) MUST run BEFORE the IMUser.update mutation.
      // Previously the update happened first, so a 409 would still have
      // dirty-written username/displayName/role/agentType to the existing
      // row before the caller's request was rejected. Reorder so the row is
      // touched only after every precondition has passed.
      let targetWorkspaceId: string | null = null;
      if (type === 'agent') {
        if (existingUser.agentCard) {
          targetWorkspaceId = requestedWorkspaceId || existingUser.agentCard.workspaceId;
          // Guard: targetWorkspaceId must be non-null at this point (agentCard.workspaceId is required)
          if (!targetWorkspaceId) {
            return c.json<ApiResponse>({ ok: false, error: 'Existing agent card has no workspaceId' }, 500);
          }

          // §② — Cross-workspace silent rebind guard. Applies to BOTH API-Key
          // proxy and direct-JWT callers (was previously only API-Key path).
          // If the caller explicitly declares a workspaceId that differs from
          // where the existing AgentCard already lives, reject with the same
          // 409 code the upstream slug-uniqueness check uses. This prevents
          // an agent from being silently relocated from wsA to wsB during a
          // re-register. Same workspaceId or omitted workspaceId is fine
          // (legitimate update path).
          if (
            requestedWorkspaceId &&
            existingUser.agentCard.workspaceId &&
            existingUser.agentCard.workspaceId !== requestedWorkspaceId
          ) {
            return c.json<ApiResponse>(
              {
                ok: false,
                error: {
                  code: 'USERNAME_TAKEN_IN_OTHER_WORKSPACE',
                  message: `Username '${username}' is already used by your agent in another workspace. Slug uniqueness is global; choose a different slug.`,
                },
              },
              409,
            );
          }

          const daemonError = await assertRequestedDaemonBelongsToWorkspace(targetWorkspaceId);
          if (daemonError) return daemonError;
          // §30 §2.6 device capacity — count this agent's existing slot via
          // its imUserId so re-registering itself does not trip the ceiling.
          const capacityError = await assertDeviceCapacityAvailable(targetWorkspaceId, existingUser.id);
          if (capacityError) return capacityError;
        } else {
          const ownerWorkspaceId = resolvedWorkspaceId ?? (await ensureOwnerWorkspaceId());
          if (ownerWorkspaceId instanceof Response) return ownerWorkspaceId;
          resolvedWorkspaceId = ownerWorkspaceId;
          targetWorkspaceId = ownerWorkspaceId;
          const daemonError = await assertRequestedDaemonBelongsToWorkspace(resolvedWorkspaceId);
          if (daemonError) return daemonError;
          // §30 §2.6 — existing user has no card yet; treat as a new slot
          // (registeringImUserId=existingUser.id won't be found in cards).
          const capacityError = await assertDeviceCapacityAvailable(resolvedWorkspaceId, existingUser.id);
          if (capacityError) return capacityError;
        }
      }

      // All preconditions cleared — now safe to update the IMUser row and
      // upsert the AgentCard.
      await prisma.iMUser.update({
        where: { id: existingUser.id },
        data: {
          username,
          displayName,
          role: type === 'agent' ? 'agent' : 'human',
          agentType: type === 'agent' ? (agentType ?? 'assistant') : null,
        },
      });
      imUserId = existingUser.id;

      if (type === 'agent') {
        if (existingUser.agentCard) {
          await prisma.iMAgentCard.update({
            where: { imUserId: existingUser.id },
            data: {
              workspaceId: targetWorkspaceId!,
              name: displayName,
              description: description ?? existingUser.agentCard.description,
              agentType: agentType ?? 'assistant',
              capabilities: JSON.stringify(capabilities ?? []),
              endpoint: endpoint ?? existingUser.agentCard.endpoint,
              metadata: buildMetadata(existingUser.agentCard.metadata),
              status: 'online',
            },
          });
        } else {
          await prisma.iMAgentCard.create({
            data: {
              imUserId: existingUser.id,
              workspaceId: resolvedWorkspaceId!,
              name: displayName,
              description: description ?? '',
              agentType: agentType ?? 'assistant',
              capabilities: JSON.stringify(capabilities ?? []),
              endpoint: endpoint ?? null,
              metadata: buildMetadata(),
              status: 'online',
            },
          });
          // Seed evolution genes for newly created agent card
          evolutionService?.seedGenesForNewAgent(existingUser.id, resolvedWorkspaceId!).catch(() => {});
        }
      }
    } else {
      // Create new user — link to cloud user if API Key auth present
      const role = type === 'agent' ? 'agent' : 'human';
      if (type === 'agent') {
        const ownerWorkspaceId = resolvedWorkspaceId ?? (await ensureOwnerWorkspaceId());
        if (ownerWorkspaceId instanceof Response) return ownerWorkspaceId;
        resolvedWorkspaceId = ownerWorkspaceId;
        const daemonError = await assertRequestedDaemonBelongsToWorkspace(resolvedWorkspaceId);
        if (daemonError) return daemonError;
        // §30 §2.6 — brand-new agent, no existing imUserId yet, so pass null.
        // assertDeviceCapacityAvailable treats this as a new slot.
        const capacityError = await assertDeviceCapacityAvailable(resolvedWorkspaceId, null);
        if (capacityError) return capacityError;
      }
      const newUser = await prisma.iMUser.create({
        data: {
          id: generateIMUserId(role),
          username,
          displayName,
          role,
          agentType: type === 'agent' ? (agentType ?? 'assistant') : null,
          userId: cloudUserId ?? ownerUserId ?? undefined,
          numericId: type === 'human' ? (ownerNumericId ?? undefined) : undefined,
          metadata: JSON.stringify({ registeredVia: 'register_api', createdAt: new Date().toISOString() }),
        },
      });
      imUserId = newUser.id;
      isNew = true;

      // Wave-4 cookbook bugfix: humans registered via /register also need a
      // default workspace. The agent path below already creates one (since
      // im_agent_cards.workspaceId is NOT NULL); the human path historically
      // relied on Cloud 1 native auth's /me auto-import to backfill, which
      // never fires for IM-only flows (cookbook scripts, agent-only test
      // fixtures, fresh dev clouds). Without a default workspace, POST
      // /api/im/tasks fails the workspaceId NOT NULL constraint and the
      // user can't create tasks against any agent they own.
      if (type === 'human' && isNew) {
        // Bug Z1.b (v2.0.7 R3.E cookbook real-run): mirror Z1 同款 $transaction。
        // workspace + owner 的 im_workspace_members 行同事务写入，避免 owner
        // 创建后立即 POST /tasks 被 task-permission.ts 拒 (403)。
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- interactive tx client typing matches workspace-member.service pattern
        const ws = await prisma.$transaction(async (tx: any) => {
          const newWs = await tx.iMWorkspace.create({
            data: {
              ownerImUserId: newUser.id,
              name: 'Personal',
              slug: 'personal',
              isDefault: true,
            },
            select: { id: true },
          });
          await tx.iMWorkspaceMember.create({
            data: {
              workspaceId: newWs.id,
              memberImUserId: newUser.id,
              role: 'owner',
            },
          });
          return newWs;
        });
        resolvedWorkspaceId = ws.id;
      }

      // Create AgentCard for agents
      if (type === 'agent') {
        await prisma.iMAgentCard.create({
          data: {
            imUserId: newUser.id,
            workspaceId: resolvedWorkspaceId,
            name: displayName,
            description: description ?? '',
            agentType: agentType ?? 'assistant',
            capabilities: JSON.stringify(capabilities ?? []),
            endpoint: endpoint ?? null,
            metadata: buildMetadata(),
            status: 'online',
          },
        });
        // Seed evolution genes for new agent
        evolutionService?.seedGenesForNewAgent(newUser.id, resolvedWorkspaceId).catch(() => {});

        // Auto-create human owner record if not exists (for owner profile / contributor board)
        if (cloudUserId) {
          const hasOwner = await prisma.iMUser.findFirst({
            where: { role: 'human', OR: cloudOwnerWhere(cloudUserId) },
            select: { id: true },
            orderBy: { createdAt: 'asc' },
          });
          if (!hasOwner) {
            const ownerUsername = `user-${cloudUserId.slice(0, 8)}`;
            const existing = await prisma.iMUser.findFirst({ where: { username: ownerUsername } });
            if (!existing) {
              await prisma.iMUser
                .create({
                  data: {
                    id: generateIMUserId('human'),
                    username: ownerUsername,
                    displayName: displayName,
                    role: 'human',
                    userId: cloudUserId,
                  },
                })
                .catch(() => {});
            }
          }
        }
      }
    }

    // If the existing user was auto-created as 'human' but registering as 'agent', it's a new registration
    if (existingUser && existingUser.role === 'human' && type === 'agent') {
      isNew = true;
    }

    if (type === 'agent') {
      const agentCard = await prisma.iMAgentCard.findUnique({
        where: { imUserId },
        select: { workspaceId: true },
      });
      if (agentCard?.workspaceId) {
        const builtInService = new BuiltInSkillService(new AgentSkillService(new SkillService()));
        await builtInService.installAllBuiltInsToAgent(imUserId, agentCard.workspaceId).catch((err: unknown) => {
          console.warn(
            '[Register] Built-in skill auto-install failed:',
            err instanceof Error ? err.message : String(err),
          );
        });
      }
    }

    // Sign new JWT token
    const token = signToken({
      sub: imUserId,
      username,
      role: type === 'agent' ? 'agent' : 'human',
      agentType: type === 'agent' ? ((agentType as any) ?? 'assistant') : undefined,
    });

    const result: RegisterResult = {
      imUserId,
      username,
      displayName,
      role: type === 'agent' ? 'agent' : 'human',
      token,
      expiresIn: '7d',
      capabilities: type === 'agent' ? (capabilities ?? []) : undefined,
      isNew,
    };

    return c.json<ApiResponse<RegisterResult>>(
      {
        ok: true,
        data: result,
      },
      isNew ? 201 : 200,
    );
  });

  return router;
}

export function createTokenRouter() {
  const router = new Hono();

  /**
   * POST /token/refresh — Refresh JWT token
   */
  router.post('/refresh', async (c) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json<ApiResponse>({ ok: false, error: 'Missing Authorization header' }, 401);
    }

    const token = authHeader.slice(7);

    // Try to verify (valid token)
    let payload;
    try {
      payload = verifyToken(token);
    } catch {
      // Try to decode (expired token — allow refresh within grace period)
      payload = decodeToken(token);
      if (!payload) {
        return c.json<ApiResponse>({ ok: false, error: 'Invalid token' }, 401);
      }
    }

    // Verify user still exists
    const user = await prisma.iMUser.findUnique({ where: { id: payload.sub } });
    if (!user) {
      return c.json<ApiResponse>({ ok: false, error: 'User not found' }, 404);
    }

    // Sign new token
    const newToken = signToken({
      sub: user.id,
      username: user.username,
      role: user.role as any,
      agentType: (user.agentType as any) ?? undefined,
    });

    return c.json<ApiResponse>({
      ok: true,
      data: {
        token: newToken,
        expiresIn: '7d',
      },
    });
  });

  return router;
}
