// `prismer skill|role <delist|relist|deprecate|undeprecate|archive|transfer|published>`
// — the publish-governance verbs (product204/21 M-P W3).
//
// Registered onto BOTH `prismer skill` and `prismer role` from one factory,
// because the W1 backend deliberately gives the three assets one isomorphic wire
// shape (see ../publish-lifecycle.ts). The only per-asset differences are:
//
//   • relist  — NOT a new endpoint: it re-runs the asset's OWN publish endpoint,
//               which is where the publish gates (license / SS-02 / takedown
//               lock) already live (21 §2.1).
//   • archive — skill: POST /:id/promote {to:'archived'}; role: DELETE /:slug.
//   • skills address their routes by id; role templates accept the slug.
//
// The governance routes answer with the IM envelope `{ ok:false, error, code,
// data }` — a top-level `code` plus a structured `data` (e.g. the consumer
// count). CloudClient.request() drops both on non-2xx (it only keeps
// `error.code`, which the IM envelope does not nest), so these commands speak to
// the endpoints with a thin raw fetch that preserves the envelope verbatim. That
// is what lets a 409 print "3 agents are still using this skill" instead of
// "HTTP 409".

import type { Command } from 'commander';
import type { CloudClient } from '../../auth.js';
import { exitWithError, printJson, runAction } from '../util.js';
import { getUI } from '../ui.js';
import {
  humanizeLifecycleError,
  publishedTableRows,
  type LifecycleFailure,
  type PublishedAssetRow,
} from '../publish-lifecycle.js';

interface RawResponse {
  status: number;
  ok: boolean;
  body: Record<string, unknown>;
}

/** Raw IM call that keeps the `{ ok, error, code, data }` envelope intact on failure. */
async function raw(
  cloud: CloudClient,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<RawResponse> {
  const res = await fetch(cloud.urlFor(path), {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${cloud.apiKey}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw_ = await res.text();
  let parsed: unknown;
  try {
    parsed = raw_ ? JSON.parse(raw_) : {};
  } catch {
    parsed = { error: raw_ };
  }
  const envelope = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  return { status: res.status, ok: res.ok && envelope.ok !== false, body: envelope };
}

/** Normalize a failed RawResponse into the shape humanizeLifecycleError expects. */
export function toFailure(res: RawResponse): LifecycleFailure {
  const err = res.body.error;
  return {
    status: res.status,
    code: typeof res.body.code === 'string' ? res.body.code : undefined,
    message:
      typeof err === 'string'
        ? err
        : typeof (err as { message?: unknown } | undefined)?.message === 'string'
          ? ((err as { message: string }).message)
          : undefined,
    data: res.body.data && typeof res.body.data === 'object' ? (res.body.data as Record<string, unknown>) : undefined,
  };
}

export interface LifecycleAsset {
  /** Noun in prose + error strings: `skill` / `role`. */
  noun: string;
  /** What a live consumer of this asset IS. */
  consumerNoun: string;
  /** Command prefix used in hints, e.g. `prismer skill`. */
  cli: string;
  /** Router mount, e.g. `/api/im/skills`. */
  base: string;
  /** Stable error-code prefix for `exitWithError` (`skill_` / `role_`). */
  codePrefix: string;
  /** Skills address their routes by id — resolve slug -> id first. Role templates take the slug. */
  resolveId?: (cloud: CloudClient, slugOrId: string) => Promise<string>;
  /** Re-run the asset's own publish endpoint (21 §2.1 — relist gets no endpoint of its own). */
  relist: (cloud: CloudClient, ref: string, opts: { changelog?: string }) => Promise<RawResponse>;
  /** The asset's own retire path, plus the `confirm` consumer door (21 §2.4). */
  archive: (cloud: CloudClient, ref: string, confirm: boolean) => Promise<RawResponse>;
}

export const SKILL_LIFECYCLE = (cli: string): LifecycleAsset => ({
  noun: 'skill',
  consumerNoun: 'agent',
  cli,
  base: '/api/im/skills',
  codePrefix: 'skill',
  resolveId: async (cloud, slugOrId) => {
    const res = await raw(cloud, 'GET', `/api/im/skills/${encodeURIComponent(slugOrId)}`);
    const id = (res.body.data as { id?: unknown } | undefined)?.id;
    if (!res.ok || typeof id !== 'string') {
      exitWithError(`No skill named '${slugOrId}' — check the slug with: ${cli} published`, {
        code: 'skill_not_found',
      });
    }
    return id as string;
  },
  relist: (cloud, id, opts) =>
    raw(cloud, 'POST', `/api/im/skills/${encodeURIComponent(id)}/publish-template`, {
      scope: 'marketplace',
      includeBoilerplateTask: false,
      ...(opts.changelog ? { changelog: opts.changelog } : {}),
    }),
  archive: (cloud, id, confirm) =>
    raw(cloud, 'POST', `/api/im/skills/${encodeURIComponent(id)}/promote`, {
      to: 'archived',
      ...(confirm ? { confirm: true } : {}),
    }),
});

export const ROLE_LIFECYCLE = (cli: string): LifecycleAsset => ({
  noun: 'role',
  consumerNoun: 'agent',
  cli,
  base: '/api/im/role-templates',
  codePrefix: 'role',
  relist: (cloud, slug) => raw(cloud, 'POST', `/api/im/role-templates/${encodeURIComponent(slug)}/publish`, {}),
  archive: (cloud, slug, confirm) =>
    raw(cloud, 'DELETE', `/api/im/role-templates/${encodeURIComponent(slug)}`, confirm ? { confirm: true } : {}),
});

/**
 * Register delist / relist / deprecate / undeprecate / archive / transfer* /
 * published onto an asset's command group.
 *
 * @param cmd     the `skill` or `role` Command
 * @param asset   per-asset endpoint + prose config
 * @param mkCloud the command group's existing CloudClient factory
 */
export function registerLifecycleCommands(
  cmd: Command,
  asset: LifecycleAsset,
  mkCloud: () => CloudClient,
): void {
  const { noun, consumerNoun, cli, base, codePrefix } = asset;

  /** slug -> the reference the asset's routes address (id for skills, slug for roles). */
  const refFor = async (cloud: CloudClient, slugOrId: string): Promise<string> =>
    asset.resolveId ? await asset.resolveId(cloud, slugOrId) : slugOrId;

  /**
   * Fail with the humanized sentence for the code the server sent.
   *
   * `extra` re-injects arguments the server does not echo back (e.g. the
   * successor slug the caller asked for) so the sentence can name them.
   */
  const bail = (res: RawResponse, slug: string, op: string, extra?: Record<string, unknown>): never => {
    const failure = toFailure(res);
    const data = { ...extra, ...(failure.data ?? {}) };
    exitWithError(humanizeLifecycleError({ ...failure, data }, { noun, consumerNoun, cli, slug, op }), {
      code: `${codePrefix}_${op.replace(/-/g, '_')}_failed`,
      details: data,
    });
  };

  // ── delist — visibility flip; live consumers are NOT touched (21 §2.1) ─────
  cmd
    .command('delist <slugOrId>')
    .description(
      `Pull a ${noun} out of the public Marketplace without touching anyone already using it (POST ${base}/:id/delist). Reversible: '${cli} relist'.`,
    )
    .option('--reason <text>', 'Reason recorded on the asset (audit trail)')
    .option('--json', 'Output JSON')
    .action(
      runAction<[string, { reason?: string; json?: boolean }]>(async (slugOrId, opts) => {
        const cloud = mkCloud();
        const ref = await refFor(cloud, slugOrId);
        const res = await raw(cloud, 'POST', `${base}/${encodeURIComponent(ref)}/delist`, {
          ...(opts.reason ? { reason: opts.reason } : {}),
        });
        if (!res.ok) bail(res, slugOrId, 'delist');
        const data = (res.body.data ?? {}) as { alreadyUnlisted?: boolean };
        if (opts.json) {
          printJson(data);
          return;
        }
        const ui = getUI();
        if (data.alreadyUnlisted) ui.ok(`Already delisted`, slugOrId);
        else ui.ok(`Delisted from Marketplace`, slugOrId);
        ui.secondary(`Everyone already using it keeps working — delist only hides it from the Marketplace.`);
        ui.secondary(`relist: ${cli} relist ${slugOrId}`);
      }, { code: `${codePrefix}_delist_failed` }),
    );

  // ── relist — re-runs the asset's OWN publish endpoint (21 §2.1) ────────────
  cmd
    .command('relist <slugOrId>')
    .description(
      `Put a delisted ${noun} back into the public Marketplace. Re-runs the publish gate, so a ${noun} taken down by an admin stays down.`,
    )
    .option('--changelog <text>', 'Changelog note recorded at relist time')
    .option('--json', 'Output JSON')
    .action(
      runAction<[string, { changelog?: string; json?: boolean }]>(async (slugOrId, opts) => {
        const cloud = mkCloud();
        const ref = await refFor(cloud, slugOrId);
        const res = await asset.relist(cloud, ref, { changelog: opts.changelog });
        if (!res.ok) bail(res, slugOrId, 'relist');
        if (opts.json) {
          printJson(res.body.data ?? {});
          return;
        }
        getUI().ok(`Re-listed on the Marketplace`, slugOrId);
      }, { code: `${codePrefix}_relist_failed` }),
    );

  // ── deprecate — a signal, not a wall: installs still succeed (裁决 2) ──────
  cmd
    .command('deprecate <slugOrId>')
    .description(
      `Mark a ${noun} deprecated and (optionally) point at its successor. It stays installable — consumers get a warning, not a block.`,
    )
    .requiredOption('--reason <text>', 'Why it is deprecated (required — consumers see this)')
    .option('--successor <slug>', `Slug of the listed ${noun} that replaces it`)
    .option('--json', 'Output JSON')
    .action(
      runAction<[string, { reason: string; successor?: string; json?: boolean }]>(async (slugOrId, opts) => {
        const cloud = mkCloud();
        const ref = await refFor(cloud, slugOrId);
        const res = await raw(cloud, 'POST', `${base}/${encodeURIComponent(ref)}/deprecate`, {
          reason: opts.reason,
          ...(opts.successor ? { successorSlug: opts.successor } : {}),
        });
        if (!res.ok) bail(res, slugOrId, 'deprecate', { successorSlug: opts.successor });
        if (opts.json) {
          printJson(res.body.data ?? {});
          return;
        }
        const ui = getUI();
        ui.ok(`Deprecated`, slugOrId);
        if (opts.successor) ui.line(`successor: ${opts.successor}`);
        ui.secondary(`Still installable — consumers now see the reason and the successor.`);
      }, { code: `${codePrefix}_deprecate_failed` }),
    );

  cmd
    .command('undeprecate <slugOrId>')
    .description(`Clear the deprecation mark from a ${noun}.`)
    .option('--json', 'Output JSON')
    .action(
      runAction<[string, { json?: boolean }]>(async (slugOrId, opts) => {
        const cloud = mkCloud();
        const ref = await refFor(cloud, slugOrId);
        const res = await raw(cloud, 'POST', `${base}/${encodeURIComponent(ref)}/undeprecate`, {});
        if (!res.ok) bail(res, slugOrId, 'undeprecate');
        if (opts.json) {
          printJson(res.body.data ?? {});
          return;
        }
        getUI().ok(`Deprecation cleared`, slugOrId);
      }, { code: `${codePrefix}_undeprecate_failed` }),
    );

  // ── archive — the destructive one: it unbinds consumers (21 §2.4) ─────────
  cmd
    .command('archive <slugOrId>')
    .description(
      `Retire a ${noun} for good. Unlike delist, this UNBINDS everyone using it — with live consumers the server refuses until you pass --confirm.`,
    )
    .option('--confirm', `Proceed even though live ${consumerNoun}s will be unbound`)
    .option('--json', 'Output JSON')
    .action(
      runAction<[string, { confirm?: boolean; json?: boolean }]>(async (slugOrId, opts) => {
        const cloud = mkCloud();
        const ref = await refFor(cloud, slugOrId);
        const res = await asset.archive(cloud, ref, opts.confirm === true);
        if (!res.ok) bail(res, slugOrId, 'archive');
        if (opts.json) {
          printJson(res.body.data ?? {});
          return;
        }
        getUI().ok(`Archived`, slugOrId);
      }, { code: `${codePrefix}_archive_failed` }),
    );

  // ── transfer — two-phase offer/accept (21 §2.5, 裁决 5) ────────────────────
  cmd
    .command('transfer <slugOrId>')
    .description(
      `Offer ownership of a ${noun} to another user. Nothing moves until they run '${cli} transfer-accept ${'<slug>'}' — you can pull the offer with '${cli} transfer-abort'.`,
    )
    .requiredOption('--to <imUserId>', 'IM user id of the recipient')
    .option('--json', 'Output JSON')
    .action(
      runAction<[string, { to: string; json?: boolean }]>(async (slugOrId, opts) => {
        const cloud = mkCloud();
        const ref = await refFor(cloud, slugOrId);
        const res = await raw(cloud, 'POST', `${base}/${encodeURIComponent(ref)}/transfer/offer`, {
          toImUserId: opts.to,
        });
        if (!res.ok) bail(res, slugOrId, 'transfer');
        const data = (res.body.data ?? {}) as { idempotent?: boolean };
        if (opts.json) {
          printJson(data);
          return;
        }
        const ui = getUI();
        ui.ok(data.idempotent ? `Transfer offer already open` : `Transfer offered`, `${slugOrId} -> ${opts.to}`);
        ui.secondary(`You stay the owner until they accept: ${cli} transfer-accept ${slugOrId}`);
      }, { code: `${codePrefix}_transfer_failed` }),
    );

  cmd
    .command('transfer-accept <slugOrId>')
    .description(`Accept a pending ownership offer on a ${noun} (run by the recipient).`)
    .option('--json', 'Output JSON')
    .action(
      runAction<[string, { json?: boolean }]>(async (slugOrId, opts) => {
        const cloud = mkCloud();
        const ref = await refFor(cloud, slugOrId);
        const res = await raw(cloud, 'POST', `${base}/${encodeURIComponent(ref)}/transfer/accept`, {});
        if (!res.ok) bail(res, slugOrId, 'transfer-accept');
        if (opts.json) {
          printJson(res.body.data ?? {});
          return;
        }
        getUI().ok(`Ownership transferred to you`, slugOrId);
      }, { code: `${codePrefix}_transfer_accept_failed` }),
    );

  cmd
    .command('transfer-abort <slugOrId>')
    .description(`Cancel a pending ownership offer (either side may run this).`)
    .option('--json', 'Output JSON')
    .action(
      runAction<[string, { json?: boolean }]>(async (slugOrId, opts) => {
        const cloud = mkCloud();
        const ref = await refFor(cloud, slugOrId);
        const res = await raw(cloud, 'POST', `${base}/${encodeURIComponent(ref)}/transfer/abort`, {});
        if (!res.ok) bail(res, slugOrId, 'transfer-abort');
        if (opts.json) {
          printJson(res.body.data ?? {});
          return;
        }
        getUI().ok(`Transfer offer withdrawn`, slugOrId);
      }, { code: `${codePrefix}_transfer_abort_failed` }),
    );

  // ── published — the owner's publication inventory (21 §2.7) ───────────────
  cmd
    .command('published')
    .description(
      `List every ${noun} you have published, with its listing state and how many ${consumerNoun}s depend on it (GET ${base}/mine/published).`,
    )
    .option('--json', 'Output JSON')
    .action(
      runAction<[{ json?: boolean }]>(async (opts) => {
        const cloud = mkCloud();
        const res = await raw(cloud, 'GET', `${base}/mine/published`);
        if (!res.ok) bail(res, '-', 'published');
        const rows = (res.body.data ?? []) as PublishedAssetRow[];
        if (opts.json) {
          printJson(rows);
          return;
        }
        const ui = getUI();
        ui.header(`Published ${noun}s (${rows.length})`);
        if (rows.length === 0) {
          ui.secondary(`Nothing published yet. Publish one: ${cli} publish <slug>`);
          return;
        }
        ui.table(publishedTableRows(rows), { columns: ['slug', 'state', 'consumers', 'installs', 'transfer'] });
        ui.secondary(`consumers = live ${consumerNoun}s that would be unbound by '${cli} archive'.`);
      }, { code: `${codePrefix}_published_failed` }),
    );
}
