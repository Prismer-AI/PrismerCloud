/**
 * Prismer IM — Unified Credit Billing Middleware
 *
 * Hono middleware that automatically deducts credits for write operations.
 *
 * Billing model: OPTIMISTIC post-deduct.
 * - Middleware is registered globally (api.use('/*')) BEFORE per-route authMiddleware.
 * - User context is only available AFTER await next() returns (auth runs inside next()).
 * - Balance check + deduct both happen post-handler.
 * - Balance may go slightly negative under concurrent requests (acceptable for 0.001-0.01 amounts).
 * - Strict enforcement happens on NEXT request (balance <= 0 → 402).
 *
 * Pricing table: maps route pattern + method to credit cost.
 * Activity recorded via description field for dashboard/stats.
 */

import type { Context, Next } from 'hono';
import type { CreditService } from '../services/credit.service';

// ─── Pricing Table ──────────────────────────────────────────

interface PricingRule {
  pattern: RegExp;
  method?: string;
  cost: number;
  category: string;
}

const PRICING_TABLE: PricingRule[] = [
  // ─── IM Messaging ──
  // Note: messages/direct/groups still deduct in their handlers.
  // Once migrated here, remove handler-level deduction and uncomment:
  // { pattern: /^\/messages\/[^/]+$/, method: 'POST', cost: 0.001, category: 'message' },
  // { pattern: /^\/direct\/[^/]+\/messages$/, method: 'POST', cost: 0.001, category: 'message' },
  // { pattern: /^\/groups\/[^/]+\/messages$/, method: 'POST', cost: 0.001, category: 'message' },

  // ─── Evolution ──
  { pattern: /^\/evolution\/analyze$/, method: 'POST', cost: 0.001, category: 'evolution' },
  { pattern: /^\/evolution\/record$/, method: 'POST', cost: 0.001, category: 'evolution' },
  { pattern: /^\/evolution\/report$/, method: 'POST', cost: 0.002, category: 'evolution' },
  { pattern: /^\/evolution\/genes$/, method: 'POST', cost: 0.005, category: 'evolution' },
  { pattern: /^\/evolution\/genes\/fork$/, method: 'POST', cost: 0.003, category: 'evolution' },
  { pattern: /^\/evolution\/genes\/import$/, method: 'POST', cost: 0.002, category: 'evolution' },
  { pattern: /^\/evolution\/sync$/, method: 'POST', cost: 0.001, category: 'evolution' },
  { pattern: /^\/evolution\/distill$/, method: 'POST', cost: 0.005, category: 'evolution' },

  // ─── Memory ──
  { pattern: /^\/memory\/files$/, method: 'POST', cost: 0.001, category: 'memory' },

  // ─── Recall ──
  { pattern: /^\/recall$/, method: 'GET', cost: 0.001, category: 'recall' },

  // ─── Skills ──
  { pattern: /^\/skills\/[^/]+\/install$/, method: 'POST', cost: 0.002, category: 'skill' },

  // ─── Tasks ──
  { pattern: /^\/tasks$/, method: 'POST', cost: 0.001, category: 'task' },

  // ─── Reports ──
  { pattern: /^\/reports$/, method: 'POST', cost: 0.01, category: 'report' },

  // ─── Workspace ──
  { pattern: /^\/workspace\/init$/, method: 'POST', cost: 0.01, category: 'workspace' },
  { pattern: /^\/workspace\/init-group$/, method: 'POST', cost: 0.01, category: 'workspace' },
];

function matchPricing(path: string, method: string): PricingRule | null {
  const routePath = path.replace(/^\/api/, '');
  for (const rule of PRICING_TABLE) {
    if (rule.method && rule.method !== method) continue;
    if (rule.pattern.test(routePath)) return rule;
  }
  return null;
}

/**
 * Create credit billing middleware.
 */
export function createCreditBilling(creditService: CreditService) {
  return async (c: Context, next: Next) => {
    const rule = matchPricing(c.req.path, c.req.method);

    if (!rule || rule.cost === 0) {
      return next();
    }

    // Run handler + authMiddleware (user context set during next())
    try {
      await next();
    } catch (err) {
      // Handler threw — re-throw so Hono returns the error
      // Don't attempt billing on failed requests
      throw err;
    }

    // Post-handler: user is now available
    const user = c.get('user');
    if (!user?.imUserId) return;

    const status = c.res.status;
    if (status < 200 || status >= 300) return;

    // Check if balance is depleted — block NEXT request by returning 402
    // Current request already completed (optimistic), but we can warn
    try {
      const balance = await creditService.getBalance(user.imUserId);
      if (balance.balance <= 0) {
        console.warn(`[CreditBilling] ${user.imUserId} balance depleted (${balance.balance.toFixed(3)})`);
      }
    } catch {
      // Best-effort
    }

    // Deduct (fire-and-forget)
    const routePath = c.req.path.replace(/^\/api/, '');
    const description = `${rule.category}: ${c.req.method} ${routePath}`;
    creditService.deduct(user.imUserId, rule.cost, description, rule.category).catch((err) => {
      console.warn(`[CreditBilling] Deduct failed for ${user.imUserId}: ${err?.message}`);
    });
  };
}

/** Export pricing table for dashboard/admin reference */
export { PRICING_TABLE };
export type { PricingRule };
