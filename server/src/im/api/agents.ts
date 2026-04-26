/**
 * Prismer IM — Agents API
 * 
 * Agent registration, discovery, and management endpoints.
 */

import { Hono } from "hono";
import { authMiddleware, requireRole } from "../auth/middleware";
import { AgentService } from "../services/agent.service";
import { AgentRegistry } from "../agent-protocol/registry";
import { PresenceService } from "../services/presence.service";
import { AGENT_PROTOCOL_VERSION } from "../agent-protocol/types";
import type { ApiResponse } from "../types/index";

export function createAgentsRouter(
  agentService: AgentService,
  agentRegistry: AgentRegistry,
  presenceService: PresenceService,
) {
  const router = new Hono();

  /**
   * POST /api/agents/register — Register an agent (requires auth as agent user)
   */
  router.post("/register", authMiddleware, async (c) => {
    const user = c.get("user");
    if (user.role !== "agent" && user.role !== "admin") {
      return c.json<ApiResponse>({ ok: false, error: "Only agent users can register" }, 403);
    }

    const body = await c.req.json();
    const { name, description, agentType, capabilities, endpoint, metadata } = body;

    if (!name || !description) {
      return c.json<ApiResponse>({ ok: false, error: "name and description are required" }, 400);
    }

    const card = await agentService.register({
      userId: user.imUserId,
      name,
      description,
      agentType: agentType ?? "assistant",
      capabilities: capabilities ?? [],
      endpoint,
      metadata,
    });

    return c.json<ApiResponse>({
      ok: true,
      data: {
        agentId: card.id,
        userId: user.imUserId,
        protocolVersion: AGENT_PROTOCOL_VERSION,
        card,
      },
    }, 201);
  });

  /**
   * GET /api/agents — Discover agents
   */
  router.get("/", authMiddleware, async (c) => {
    const agentType = c.req.query("agentType") as any;
    const capability = c.req.query("capability");
    const onlineOnly = c.req.query("onlineOnly") === "true";

    const agents = await agentRegistry.discover({
      agentType,
      capability,
      onlineOnly,
    });

    return c.json<ApiResponse>({ ok: true, data: agents });
  });

  /**
   * GET /api/agents/:userId — Get agent details
   */
  router.get("/:userId", authMiddleware, async (c) => {
    const userId = c.req.param("userId")!;
    const info = await agentRegistry.getAgentInfo(userId);
    if (!info) {
      return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
    }

    // Get presence info
    const presence = await presenceService.getStatus(userId);

    return c.json<ApiResponse>({
      ok: true,
      data: { ...info, presence },
    });
  });

  /**
   * POST /api/agents/:userId/heartbeat — Agent heartbeat (alternative to WS)
   */
  router.post("/:userId/heartbeat", authMiddleware, async (c) => {
    const user = c.get("user");
    const userId = c.req.param("userId")!;

    if (user.imUserId !== userId) {
      return c.json<ApiResponse>({ ok: false, error: "Can only send own heartbeat" }, 403);
    }

    const body = await c.req.json();
    await agentService.heartbeat(userId, {
      status: body.status ?? "online",
      load: body.load,
      activeConversations: body.activeConversations,
    });

    return c.json<ApiResponse>({ ok: true });
  });

  /**
   * DELETE /api/agents/:userId — Unregister an agent
   */
  router.delete("/:userId", authMiddleware, async (c) => {
    const user = c.get("user");
    const userId = c.req.param("userId")!;

    if (user.imUserId !== userId && user.role !== "admin") {
      return c.json<ApiResponse>({ ok: false, error: "Forbidden" }, 403);
    }

    await agentService.unregister(userId);
    return c.json<ApiResponse>({ ok: true });
  });

  /**
   * GET /api/agents/discover/:capability — Find best agent for a capability
   */
  router.get("/discover/:capability", authMiddleware, async (c) => {
    const capability = c.req.param("capability")!;
    const best = await agentRegistry.findBestForCapability(capability);
    if (!best) {
      return c.json<ApiResponse>({ ok: false, error: "No agent found for this capability" }, 404);
    }
    return c.json<ApiResponse>({ ok: true, data: best });
  });

  return router;
}
