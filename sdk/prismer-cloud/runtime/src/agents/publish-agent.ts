/**
 * Prismer Runtime — Publish a locally-installed agent to cloud (D3 flow).
 *
 *   prismer agent publish <name>     → cloud knows this device runs <name>
 *   prismer agent unpublish <name>   → cloud forgets it (heartbeat stops)
 *
 * publish:
 *   1. Resolve agent catalog entry by `name` (must be installed locally —
 *      we use the catalog as the source of truth for capabilities/tiers).
 *   2. Resolve daemon identity (apiKey + daemonId + cloudApiBase).
 *   3. POST /api/im/agents/register with {name, daemonId, localAgentId,
 *      adapter, tiersSupported, capabilityTags}. Cloud responds with
 *      {agentId, userId, ...} — we keep `agentId` as the cloudAgentId.
 *   4. Persist into ~/.prismer/published-agents.toml so the daemon's
 *      heartbeat loop (Sprint A2.3) keeps refreshing it.
 *
 * unpublish:
 *   1. Read local registry to find cloudAgentId.
 *   2. Best-effort DELETE /api/im/me/agents/:cloudAgentId (owner-scoped —
 *      authenticates with API key, verifies ownership by cloudUserId).
 *      If the call fails, sweep cron marks it offline after 90s.
 *   3. Remove from local registry so heartbeat stops.
 */

import * as os from 'node:os';
import { getAgent } from './registry.js';
import {
  upsertPublished,
  removePublished,
  findPublished,
  type PublishedAgent,
} from './published-registry.js';

export interface PublishContext {
  apiKey?: string;
  daemonId?: string;
  cloudApiBase?: string;
  fetchImpl?: typeof fetch;
  /** Override hostname for tests. */
  hostname?: string;
  /** Override the local registry file path for tests. */
  registryFile?: string;
}

export interface PublishResult {
  ok: true;
  cloudAgentId: string;
  imUserId: string;
  alreadyPublished: boolean;
}

export interface PublishError {
  ok: false;
  error: string;
  status?: number;
}

export async function publishAgent(name: string, ctx: PublishContext): Promise<PublishResult | PublishError> {
  if (!ctx.apiKey) return { ok: false, error: 'PRISMER_API_KEY not set (run `prismer setup` first)' };
  if (!ctx.daemonId) return { ok: false, error: 'daemonId unresolved (run `prismer pair` first)' };
  const cloudApiBase = ctx.cloudApiBase ?? 'https://prismer.cloud';
  const fetchImpl = ctx.fetchImpl ?? fetch;

  const entry = getAgent(name);
  if (!entry) return { ok: false, error: `unknown agent "${name}" (not in catalog)` };

  const hostname = ctx.hostname ?? os.hostname();
  const localAgentId = `${name}@${hostname}`;
  const existing = findPublished(name, ctx.registryFile);

  // IMUser.username is globally unique across ALL cloud users (schema-
  // enforced), so bare agent names like "openclaw" collide across accounts
  // ("Username 'openclaw' is already taken" 409). Scope the username by
  // the daemon fingerprint (sha256(apiKey) = 16-hex) so different users'
  // same-named agents don't fight for the row. 16-hex keeps collision odds
  // at ~1/2^64. The scoped name is stable per (apiKey, agent-name) pair
  // → idempotent re-publish.
  //
  // `<name>-<16-hex>` fits register.ts USERNAME_REGEX (alnum + _ -, 3-32).
  // Max observed: "openclaw-1e4f393bfe9440e8" = 25 chars < 32.
  const daemonSuffix = ctx.daemonId.replace(/^daemon:/, '').slice(0, 16);
  const scopedUsername = `${name}-${daemonSuffix}`;

  // Step 1 — ensure a role=agent IMUser exists for this cloudUser under the
  // scoped username. /api/im/register is the canonical path to create /
  // upgrade role=agent (flips from 'human' on update when type='agent').
  // Idempotent — existing agent IMUsers are just refreshed.
  //
  // Without this, step 2 hits middleware's ensureIMUser which falls back
  // to findFirst-without-agentHint, non-deterministically returning a
  // role=human IMUser on multi-agent accounts → /api/im/agents/register
  // returns 403 "Only agent users can register".
  try {
    const identityResp = await fetchImpl(`${cloudApiBase}/api/im/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ctx.apiKey}`,
      },
      body: JSON.stringify({
        type: 'agent',
        username: scopedUsername,
        displayName: entry.displayName ?? name,
        agentType: 'assistant',
        capabilities: entry.capabilityTags ?? [],
      }),
    });
    if (!identityResp.ok) {
      // 409 = username global collision. Usually means: (a) stale IMUser row
      // from a prior test run that had userId=null (orphan) or (b) a legit
      // cross-tenant name squat. Either way, step 2 will proceed — middleware
      // either finds our agent IMUser via agentHint, or falls back to a
      // role=agent IMUser from our pool. If neither works, step 2's register
      // returns its own 403 with clearer diagnostics. 409 is therefore
      // recoverable; other codes (4xx/5xx) surface as fatal as before.
      if (identityResp.status !== 409) {
        let detail = '';
        try {
          detail = ' — ' + (await identityResp.text()).slice(0, 200);
        } catch {
          // swallow
        }
        return {
          ok: false,
          error: `identity bootstrap failed (HTTP ${identityResp.status})${detail}`,
          status: identityResp.status,
        };
      }
      // else: swallow 409 and continue to step 2
    }
  } catch (err) {
    return { ok: false, error: `identity bootstrap network: ${(err as Error).message}` };
  }

  // Step 2 — idempotent re-publish: cloud register is upsert by imUserId, so
  // calling again refreshes capabilities + flips status to online.
  //
  // `X-IM-Agent` carries the scoped username so middleware's ensureIMUser
  // picks the agent IMUser we just created/refreshed (by (cloudUserId,
  // username)). body.name stays the bare agent name — that's what ends up
  // on IMAgentCard.name (the field UI / bindings reference).
  let resp: Response;
  try {
    resp = await fetchImpl(`${cloudApiBase}/api/im/agents/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ctx.apiKey}`,
        'X-IM-Agent': scopedUsername,
      },
      body: JSON.stringify({
        name,
        description: entry.displayName ?? name,
        agentType: 'assistant',
        capabilities: entry.capabilityTags ?? [],
        daemonId: ctx.daemonId,
        localAgentId,
        adapter: name,
        tiersSupported: entry.tiersSupported ? entry.tiersSupported.join(',') : undefined,
        capabilityTags: entry.capabilityTags ?? [],
      }),
    });
  } catch (err) {
    return { ok: false, error: `network: ${(err as Error).message}` };
  }

  if (!resp.ok) {
    let detail = '';
    try {
      detail = ' — ' + (await resp.text()).slice(0, 200);
    } catch {
      // ignore
    }
    return { ok: false, error: `register failed${detail}`, status: resp.status };
  }

  let body: any;
  try {
    body = await resp.json();
  } catch {
    return { ok: false, error: 'register returned non-JSON', status: resp.status };
  }

  const data = body?.data ?? body;
  const cloudAgentId: string | undefined = data?.agentId ?? data?.card?.id;
  const imUserId: string | undefined = data?.userId ?? data?.card?.imUserId;
  if (!cloudAgentId || !imUserId) {
    return { ok: false, error: 'register response missing agentId/userId' };
  }

  const record: PublishedAgent = {
    name,
    cloudAgentId,
    localAgentId,
    adapter: name,
    publishedAt: new Date().toISOString(),
  };
  upsertPublished(record, ctx.registryFile);

  return {
    ok: true,
    cloudAgentId,
    imUserId,
    alreadyPublished: existing !== undefined,
  };
}

export interface UnpublishResult {
  ok: true;
  cloudAgentId: string | null;
  cloudDeleteAttempted: boolean;
  cloudDeleteOk: boolean;
}

export async function unpublishAgent(name: string, ctx: PublishContext): Promise<UnpublishResult | PublishError> {
  const existing = findPublished(name, ctx.registryFile);
  if (!existing) {
    // Not published locally — nothing to unpublish, but not an error.
    return { ok: true, cloudAgentId: null, cloudDeleteAttempted: false, cloudDeleteOk: false };
  }

  const cloudApiBase = ctx.cloudApiBase ?? 'https://prismer.cloud';
  const fetchImpl = ctx.fetchImpl ?? fetch;
  let cloudDeleteOk = false;

  if (ctx.apiKey) {
    try {
      // Owner-scoped DELETE: authenticates with the caller's API key and
      // verifies IMAgentCard.imUser.userId === caller's cloudUserId
      // (returns 404, not 403, on ownership mismatch — no info leak).
      // Best-effort: if cloud is unreachable, sweep job marks offline in 90s.
      const resp = await fetchImpl(`${cloudApiBase}/api/im/me/agents/${existing.cloudAgentId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${ctx.apiKey}` },
      });
      cloudDeleteOk = resp.ok;
    } catch {
      cloudDeleteOk = false;
    }
  }

  removePublished(name, ctx.registryFile);
  return {
    ok: true,
    cloudAgentId: existing.cloudAgentId,
    cloudDeleteAttempted: !!ctx.apiKey,
    cloudDeleteOk,
  };
}
