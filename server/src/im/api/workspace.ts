/**
 * Prismer IM — Workspace API
 *
 * Endpoints for workspace-IM integration:
 * - Initialize workspace with conversation and optional agent
 * - Add/remove agents from workspace
 * - Generate agent tokens
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import { WorkspaceBridgeService } from '../services/workspace-bridge.service';
import { WorkspaceViewService } from '../services/workspace-view.service';
import { MentionService } from '../services/mention.service';
import type { ApiResponse } from '../types/index';
import type { WorkspaceSlot } from '../types/workspace';
import { isValidScope } from '../utils/scope';
import { getPersonAgentIds } from '../utils/person-agent-ids';
import prisma from '../db';
import type Redis from 'ioredis';

export function createWorkspaceRouter(redis: Redis) {
  const router = new Hono();
  const workspaceBridge = new WorkspaceBridgeService(redis);
  const mentionService = new MentionService();

  /**
   * POST /api/workspace/init — Initialize workspace with IM conversation
   *
   * This is the main entry point for setting up a workspace with IM.
   * Creates conversation, user binding, and optional agent.
   */
  router.post('/init', authMiddleware, async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid or missing JSON body' }, 400);
    }
    const { workspaceId, userId, userDisplayName, agentName, agentDisplayName, agentType, agentCapabilities, force } =
      body;

    if (!workspaceId || !userId || !userDisplayName) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: 'workspaceId, userId, and userDisplayName are required',
        },
        400,
      );
    }

    try {
      const result = await workspaceBridge.initializeWorkspace({
        workspaceId,
        userId,
        userDisplayName,
        agentName,
        agentDisplayName,
        agentType,
        agentCapabilities,
        force: !!force,
      });

      return c.json<ApiResponse>(
        {
          ok: true,
          data: result,
        },
        201,
      );
    } catch (err) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: (err as Error).message,
        },
        500,
      );
    }
  });

  /**
   * POST /api/workspace/init-group — Initialize a GROUP workspace with multiple users and agents
   *
   * One-stop API for creating a multi-user multi-agent group chat.
   */
  router.post('/init-group', authMiddleware, async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid or missing JSON body' }, 400);
    }
    const { workspaceId, title, description, users, agents, force } = body;

    if (!workspaceId || !title) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: 'workspaceId and title are required',
        },
        400,
      );
    }

    if (!users || !Array.isArray(users) || users.length === 0) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: 'users array is required and must have at least one user',
        },
        400,
      );
    }

    // Validate users have required fields
    for (const user of users) {
      if (!user.userId || !user.displayName) {
        return c.json<ApiResponse>(
          {
            ok: false,
            error: 'Each user must have userId and displayName',
          },
          400,
        );
      }
    }

    // Validate agents if provided
    if (agents && Array.isArray(agents)) {
      for (const agent of agents) {
        if (!agent.name || !agent.displayName) {
          return c.json<ApiResponse>(
            {
              ok: false,
              error: 'Each agent must have name and displayName',
            },
            400,
          );
        }
      }
    }

    try {
      const result = await workspaceBridge.initializeGroupWorkspace({
        workspaceId,
        title,
        description,
        force: !!force,
        users,
        agents: agents ?? [],
      });

      return c.json<ApiResponse>(
        {
          ok: true,
          data: result,
        },
        201,
      );
    } catch (err) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: (err as Error).message,
        },
        500,
      );
    }
  });

  /**
   * POST /api/workspace/:workspaceId/agents — Add agent to workspace
   */
  router.post('/:workspaceId/agents', authMiddleware, async (c) => {
    const workspaceId = c.req.param('workspaceId');
    const body = await c.req.json();
    const { agentName, agentDisplayName, agentType, capabilities, metadata } = body;

    if (!agentName || !agentDisplayName) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: 'agentName and agentDisplayName are required',
        },
        400,
      );
    }

    try {
      const result = await workspaceBridge.createAgentForWorkspace({
        workspaceId,
        agentName,
        agentDisplayName,
        agentType,
        capabilities,
        metadata,
      });

      return c.json<ApiResponse>(
        {
          ok: true,
          data: result,
        },
        201,
      );
    } catch (err) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: (err as Error).message,
        },
        500,
      );
    }
  });

  /**
   * GET /api/workspace/:workspaceId/agents — List agents in workspace
   */
  router.get('/:workspaceId/agents', authMiddleware, async (c) => {
    const workspaceId = c.req.param('workspaceId');

    try {
      const agents = await workspaceBridge.listWorkspaceAgents(workspaceId);

      return c.json<ApiResponse>({
        ok: true,
        data: agents,
      });
    } catch (err) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: (err as Error).message,
        },
        500,
      );
    }
  });

  /**
   * POST /api/workspace/:workspaceId/agents/:agentId/token — Generate new token for agent
   */
  router.post('/:workspaceId/agents/:agentId/token', authMiddleware, async (c) => {
    const agentId = c.req.param('agentId');

    try {
      const token = await workspaceBridge.generateAgentToken(agentId);

      return c.json<ApiResponse>({
        ok: true,
        data: { token, expiresIn: '7d' },
      });
    } catch (err) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: (err as Error).message,
        },
        500,
      );
    }
  });

  /**
   * GET /api/workspace/:workspaceId/conversation — Get workspace conversation
   */
  router.get('/:workspaceId/conversation', authMiddleware, async (c) => {
    const workspaceId = c.req.param('workspaceId');

    try {
      const conversation = await workspaceBridge.getWorkspaceConversation(workspaceId);

      if (!conversation) {
        return c.json<ApiResponse>(
          {
            ok: false,
            error: 'Workspace conversation not found',
          },
          404,
        );
      }

      return c.json<ApiResponse>({
        ok: true,
        data: conversation,
      });
    } catch (err) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: (err as Error).message,
        },
        500,
      );
    }
  });

  /**
   * GET /api/workspace/:workspaceId/messages — Get workspace messages
   */
  router.get('/:workspaceId/messages', authMiddleware, async (c) => {
    const workspaceId = c.req.param('workspaceId');
    const limit = parseInt(c.req.query('limit') ?? '50', 10);

    try {
      const messages = await workspaceBridge.getWorkspaceMessages(workspaceId, limit);

      return c.json<ApiResponse>({
        ok: true,
        data: messages,
      });
    } catch (err) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: (err as Error).message,
        },
        500,
      );
    }
  });

  /**
   * GET /api/workspace/mentions/autocomplete — Get @mention autocomplete suggestions
   */
  router.get('/mentions/autocomplete', authMiddleware, async (c) => {
    const conversationId = c.req.query('conversationId');
    const query = c.req.query('query') ?? '';
    const limit = parseInt(c.req.query('limit') ?? '5', 10);

    if (!conversationId) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: 'conversationId is required',
        },
        400,
      );
    }

    try {
      const suggestions = await mentionService.getAutocompleteSuggestions(conversationId, query, limit);

      return c.json<ApiResponse>({
        ok: true,
        data: suggestions,
      });
    } catch (err) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: (err as Error).message,
        },
        500,
      );
    }
  });

  // ── Workspace Superset View ──────────────────────────────────────────

  const workspaceView = new WorkspaceViewService();

  /**
   * GET /api/workspace — Superset aggregation view
   *
   * Query params:
   *   scope     — workspace scope (default: 'global')
   *   slots     — comma-separated slot names (default: all 8 slots)
   *   includeContent — 'true' to include memory file content (default: false)
   */
  router.get('/', authMiddleware, async (c) => {
    const user = c.get('user');
    const scope = c.req.query('scope') || 'global';
    if (!isValidScope(scope)) {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid scope format' }, 400);
    }
    const slotsParam = c.req.query('slots') || 'genes,memory,personality,identity,catalog,tasks,credits,extensions';
    const slots = slotsParam.split(',').filter(Boolean) as WorkspaceSlot[];
    const includeContent = c.req.query('includeContent') === 'true';

    try {
      // Scope access check: non-global scopes require the user's agents to belong to the scope
      if (scope !== 'global') {
        const personAgentIds = await getPersonAgentIds(user.imUserId);
        const scopedAgent = await prisma.iMGene.findFirst({
          where: { ownerAgentId: { in: personAgentIds }, scope },
          select: { id: true },
        });
        const scopedSkill = !scopedAgent
          ? await prisma.iMAgentSkill.findFirst({
              where: { agentId: { in: personAgentIds }, scope },
              select: { id: true },
            })
          : scopedAgent;
        if (!scopedSkill) {
          return c.json<ApiResponse>({ ok: false, error: 'Not authorized for this scope' }, 403);
        }
      }

      const view = await workspaceView.getView(user.imUserId, scope, slots, includeContent);
      return c.json<ApiResponse>({ ok: true, data: view });
    } catch (err) {
      console.error('[WorkspaceAPI] View error:', err);
      return c.json<ApiResponse>({ ok: false, error: (err as Error).message }, 500);
    }
  });

  return router;
}
