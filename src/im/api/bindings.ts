/**
 * Prismer IM — Bindings API
 *
 * POST   /bindings              — Create binding
 * POST   /bindings/:id/verify   — Verify binding
 * GET    /bindings              — List my bindings
 * DELETE /bindings/:id          — Revoke binding
 */

import { Hono } from "hono";
import { authMiddleware } from "../auth/middleware";
import { BindingService } from "../services/binding.service";
import type { ApiResponse, CreateBindingInput } from "../types/index";

export function createBindingsRouter(bindingService: BindingService) {
  const router = new Hono();

  router.use("*", authMiddleware);

  /**
   * POST /bindings — Create a new social binding
   */
  router.post("/", async (c) => {
    const user = c.get("user");
    const body = await c.req.json<CreateBindingInput>();

    if (!body.platform) {
      return c.json<ApiResponse>(
        { ok: false, error: "platform is required" },
        400
      );
    }

    try {
      const result = await bindingService.create(user.imUserId, body);
      return c.json<ApiResponse>({ ok: true, data: result }, 201);
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes("Already bound")) {
        return c.json<ApiResponse>({ ok: false, error: message }, 409);
      }
      if (message.includes("Invalid platform")) {
        return c.json<ApiResponse>({ ok: false, error: message }, 400);
      }
      return c.json<ApiResponse>({ ok: false, error: message }, 500);
    }
  });

  /**
   * POST /bindings/:id/verify — Verify a binding with code
   */
  router.post("/:id/verify", async (c) => {
    const user = c.get("user");
    const bindingId = c.req.param("id");
    const body = await c.req.json<{ code: string }>();

    if (!body.code) {
      return c.json<ApiResponse>(
        { ok: false, error: "code is required" },
        400
      );
    }

    try {
      const result = await bindingService.verify(
        bindingId,
        user.imUserId,
        body.code
      );
      return c.json<ApiResponse>({ ok: true, data: result });
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes("not found")) {
        return c.json<ApiResponse>({ ok: false, error: message }, 404);
      }
      if (message.includes("Not your")) {
        return c.json<ApiResponse>({ ok: false, error: message }, 403);
      }
      if (
        message.includes("Invalid verification") ||
        message.includes("cannot verify")
      ) {
        return c.json<ApiResponse>({ ok: false, error: message }, 400);
      }
      return c.json<ApiResponse>({ ok: false, error: message }, 500);
    }
  });

  /**
   * GET /bindings — List my bindings
   */
  router.get("/", async (c) => {
    const user = c.get("user");
    const bindings = await bindingService.list(user.imUserId);
    return c.json<ApiResponse>({ ok: true, data: bindings });
  });

  /**
   * DELETE /bindings/:id — Revoke a binding
   */
  router.delete("/:id", async (c) => {
    const user = c.get("user");
    const bindingId = c.req.param("id");

    try {
      await bindingService.revoke(bindingId, user.imUserId);
      return c.json<ApiResponse>({ ok: true });
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes("not found")) {
        return c.json<ApiResponse>({ ok: false, error: message }, 404);
      }
      if (message.includes("Not your")) {
        return c.json<ApiResponse>({ ok: false, error: message }, 403);
      }
      return c.json<ApiResponse>({ ok: false, error: message }, 500);
    }
  });

  return router;
}
