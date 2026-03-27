/**
 * Prismer IM — Credits API
 *
 * GET /credits         — Balance
 * GET /credits/transactions — Transaction history
 */

import { Hono } from "hono";
import { authMiddleware } from "../auth/middleware";
import type { CreditService } from "../services/credit.service";
import type { ApiResponse } from "../types/index";

export function createCreditsRouter(creditService: CreditService) {
  const router = new Hono();

  router.use("*", authMiddleware);

  /**
   * GET /credits — Get balance
   */
  router.get("/", async (c) => {
    const user = c.get("user");

    const balance = await creditService.getBalance(user.imUserId);

    return c.json<ApiResponse>({
      ok: true,
      data: balance,
    });
  });

  /**
   * GET /credits/transactions — Transaction history
   */
  router.get("/transactions", async (c) => {
    const user = c.get("user");
    const limit = parseInt(c.req.query("limit") ?? "20", 10);
    const offset = parseInt(c.req.query("offset") ?? "0", 10);

    const result = await creditService.getTransactions(
      user.imUserId,
      Math.min(limit, 100),
      Math.max(offset, 0)
    );

    return c.json<ApiResponse>({
      ok: true,
      data: result.transactions,
      meta: { total: result.total, pageSize: limit },
    });
  });

  return router;
}
