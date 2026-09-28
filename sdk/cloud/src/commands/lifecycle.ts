// `cloud skill|role <delist|relist|deprecate|undeprecate|archive|transfer|published>`
// — the publish-governance verbs (product204/21 M-P W3), agent-facing port of
// the daemon CLI's `prismer skill|role` equivalents.
//
// One factory drives both asset groups because the W1 backend gives the three
// publishable assets ONE isomorphic wire shape. Per-asset deltas:
//
//   • relist  — NOT a new endpoint: re-runs the asset's OWN publish endpoint, so
//               the publish gates (license / SS-02 / admin-takedown lock) stay in
//               exactly one place per asset (21 §2.1).
//   • archive — skill: POST /:id/promote {to:'archived'}; role: DELETE /:slug.
//   • skills address their governance routes by id; role templates take the slug.
//
// The error-code -> human-sentence table is shared verbatim with the daemon CLI
// (./shared/publish-lifecycle — a Cloud-owned zero-dependency module, inlined
// at build time exactly like commands/skill.ts does for ../bundle/index). Two
// CLIs must never drift on what a 409 means.
//
// Envelope note: `client.im.request<T>()` returns the parsed BODY (no HTTP
// status). The IM error envelope carries `{ ok:false, error:<string>, code, data }`
// and the SDK preserves the top-level `code` + `data` on non-2xx — which is
// precisely what lets a 409 print "3 agents are still using this skill" rather
// than a bare status.

import type { Command } from 'commander';
import type { PrismerClient } from '../index';
import {
  humanizeLifecycleError,
  publishedTableRows,
  type LifecycleFailure,
  type PublishedAssetRow,
} from './shared/publish-lifecycle';

type ClientFactory = () => PrismerClient;

/** The IM envelope as the SDK surfaces it — `error` is a string on IM routes. */
interface LifecycleEnvelope<T = unknown> {
  ok?: boolean;
  data?: T;
  error?: string | { code?: string; message?: string };
  code?: string;
}

function toFailure(res: LifecycleEnvelope<unknown>): LifecycleFailure {
  const message = typeof res.error === 'string' ? res.error : res.error?.message;
  const code = res.code ?? (typeof res.error === 'object' ? res.error?.code : undefined);
  return {
    code,
    message,
    data: res.data && typeof res.data === 'object' ? (res.data as Record<string, unknown>) : undefined,
  };
}

interface LifecycleAsset {
  noun: string;
  consumerNoun: string;
  /** Hint prefix, e.g. `cloud skill`. */
  cli: string;
  /** Router mount, e.g. `/api/im/skills`. */
  base: string;
  /** Skills address their routes by id; roles take the slug. */
  byId: boolean;
  relist(client: PrismerClient, ref: string, opts: { changelog?: string }): Promise<LifecycleEnvelope>;
  archive(client: PrismerClient, ref: string, confirm: boolean): Promise<LifecycleEnvelope>;
}

const ASSETS: Record<'skill' | 'role', LifecycleAsset> = {
  skill: {
    noun: 'skill',
    consumerNoun: 'agent',
    cli: 'cloud skill',
    base: '/api/im/skills',
    byId: true,
    relist: (client, id, opts) =>
      client.im.request<LifecycleEnvelope>('POST', `/api/im/skills/${encodeURIComponent(id)}/publish-template`, {
        scope: 'marketplace',
        includeBoilerplateTask: false,
        ...(opts.changelog ? { changelog: opts.changelog } : {}),
      }),
    archive: (client, id, confirm) =>
      client.im.request<LifecycleEnvelope>('POST', `/api/im/skills/${encodeURIComponent(id)}/promote`, {
        to: 'archived',
        ...(confirm ? { confirm: true } : {}),
      }),
  },
  role: {
    noun: 'role',
    consumerNoun: 'agent',
    cli: 'cloud role',
    base: '/api/im/role-templates',
    byId: false,
    relist: (client, slug) =>
      client.im.request<LifecycleEnvelope>('POST', `/api/im/role-templates/${encodeURIComponent(slug)}/publish`, {}),
    archive: (client, slug, confirm) =>
      client.im.request<LifecycleEnvelope>(
        'DELETE',
        `/api/im/role-templates/${encodeURIComponent(slug)}`,
        confirm ? { confirm: true } : {},
      ),
  },
};

/**
 * Register the seven governance verbs onto `cloud skill` / `cloud role`.
 *
 * @param cmd     the `skill` or `role` Command built by commands/{skill,role}.ts
 * @param kind    which asset's endpoints + prose to use
 * @param getIMClient the caller's existing IM client factory
 */
export function registerLifecycleCommands(
  cmd: Command,
  kind: 'skill' | 'role',
  getIMClient: ClientFactory,
): void {
  const asset = ASSETS[kind];
  const { noun, consumerNoun, cli, base } = asset;

  /**
   * Print the humanized sentence for the server's code, then exit non-zero.
   *
   * `extra` re-injects arguments the server does not echo back (e.g. the
   * successor slug the caller asked for) so the sentence can name them.
   */
  const bail = (
    res: LifecycleEnvelope<unknown>,
    slug: string,
    op: string,
    extra?: Record<string, unknown>,
  ): never => {
    const failure = toFailure(res);
    const data = { ...extra, ...(failure.data ?? {}) };
    process.stderr.write(
      `Error: ${humanizeLifecycleError({ ...failure, data }, { noun, consumerNoun, cli, slug, op })}\n`,
    );
    process.exit(1);
  };

  /** slug -> the reference the asset's routes address (id for skills, slug for roles). */
  const refFor = async (client: PrismerClient, slugOrId: string): Promise<string> => {
    if (!asset.byId) return slugOrId;
    const detail = await client.im.request<LifecycleEnvelope<{ id?: string }>>(
      'GET',
      `${base}/${encodeURIComponent(slugOrId)}`,
    );
    const id = detail?.data?.id;
    if (!id) {
      process.stderr.write(`Error: No ${noun} named '${slugOrId}' — check the slug with: ${cli} published\n`);
      process.exit(1);
    }
    return id;
  };

  const guard = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err: unknown) {
      process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  };

  // ── delist — visibility flip; live consumers are NOT touched (21 §2.1) ─────
  cmd
    .command('delist <slugOrId>')
    .description(
      `Pull a ${noun} out of the public Marketplace without touching anyone already using it (POST ${base}/:id/delist). Reversible: '${cli} relist'.`,
    )
    .option('--reason <text>', 'Reason recorded on the asset (audit trail)')
    .option('--json', 'Output JSON')
    .action((slugOrId: string, opts: { reason?: string; json?: boolean }) =>
      guard(async () => {
        const client = getIMClient();
        const ref = await refFor(client, slugOrId);
        const res = await client.im.request<LifecycleEnvelope<{ alreadyUnlisted?: boolean }>>(
          'POST',
          `${base}/${encodeURIComponent(ref)}/delist`,
          { ...(opts.reason ? { reason: opts.reason } : {}) },
        );
        if (!res.ok) bail(res, slugOrId, 'delist');
        if (opts.json) {
          process.stdout.write(JSON.stringify(res.data ?? {}, null, 2) + '\n');
          return;
        }
        process.stdout.write(
          `${res.data?.alreadyUnlisted ? 'Already delisted' : 'Delisted from Marketplace'}: ${slugOrId}\n` +
            `  Everyone already using it keeps working — delist only hides it from the Marketplace.\n` +
            `  relist: ${cli} relist ${slugOrId}\n`,
        );
      }),
    );

  // ── relist — re-runs the asset's OWN publish endpoint (21 §2.1) ────────────
  cmd
    .command('relist <slugOrId>')
    .description(
      `Put a delisted ${noun} back into the public Marketplace. Re-runs the publish gate, so a ${noun} taken down by an admin stays down.`,
    )
    .option('--changelog <text>', 'Changelog note recorded at relist time')
    .option('--json', 'Output JSON')
    .action((slugOrId: string, opts: { changelog?: string; json?: boolean }) =>
      guard(async () => {
        const client = getIMClient();
        const ref = await refFor(client, slugOrId);
        const res = await asset.relist(client, ref, { changelog: opts.changelog });
        if (!res.ok) bail(res, slugOrId, 'relist');
        if (opts.json) {
          process.stdout.write(JSON.stringify(res.data ?? {}, null, 2) + '\n');
          return;
        }
        process.stdout.write(`Re-listed on the Marketplace: ${slugOrId}\n`);
      }),
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
    .action((slugOrId: string, opts: { reason: string; successor?: string; json?: boolean }) =>
      guard(async () => {
        const client = getIMClient();
        const ref = await refFor(client, slugOrId);
        const res = await client.im.request<LifecycleEnvelope>(
          'POST',
          `${base}/${encodeURIComponent(ref)}/deprecate`,
          { reason: opts.reason, ...(opts.successor ? { successorSlug: opts.successor } : {}) },
        );
        if (!res.ok) bail(res, slugOrId, 'deprecate', { successorSlug: opts.successor });
        if (opts.json) {
          process.stdout.write(JSON.stringify(res.data ?? {}, null, 2) + '\n');
          return;
        }
        process.stdout.write(
          `Deprecated: ${slugOrId}${opts.successor ? ` (successor: ${opts.successor})` : ''}\n` +
            `  Still installable — consumers now see the reason and the successor.\n`,
        );
      }),
    );

  cmd
    .command('undeprecate <slugOrId>')
    .description(`Clear the deprecation mark from a ${noun}.`)
    .option('--json', 'Output JSON')
    .action((slugOrId: string, opts: { json?: boolean }) =>
      guard(async () => {
        const client = getIMClient();
        const ref = await refFor(client, slugOrId);
        const res = await client.im.request<LifecycleEnvelope>(
          'POST',
          `${base}/${encodeURIComponent(ref)}/undeprecate`,
          {},
        );
        if (!res.ok) bail(res, slugOrId, 'undeprecate');
        if (opts.json) {
          process.stdout.write(JSON.stringify(res.data ?? {}, null, 2) + '\n');
          return;
        }
        process.stdout.write(`Deprecation cleared: ${slugOrId}\n`);
      }),
    );

  // ── archive — the destructive one: it unbinds consumers (21 §2.4) ─────────
  cmd
    .command('archive <slugOrId>')
    .description(
      `Retire a ${noun} for good. Unlike delist, this UNBINDS everyone using it — with live consumers the server refuses until you pass --confirm.`,
    )
    .option('--confirm', `Proceed even though live ${consumerNoun}s will be unbound`)
    .option('--json', 'Output JSON')
    .action((slugOrId: string, opts: { confirm?: boolean; json?: boolean }) =>
      guard(async () => {
        const client = getIMClient();
        const ref = await refFor(client, slugOrId);
        const res = await asset.archive(client, ref, opts.confirm === true);
        if (!res.ok) bail(res, slugOrId, 'archive');
        if (opts.json) {
          process.stdout.write(JSON.stringify(res.data ?? {}, null, 2) + '\n');
          return;
        }
        process.stdout.write(`Archived: ${slugOrId}\n`);
      }),
    );

  // ── transfer — two-phase offer/accept (21 §2.5, 裁决 5) ────────────────────
  cmd
    .command('transfer <slugOrId>')
    .description(
      `Offer ownership of a ${noun} to another user. Nothing moves until they run '${cli} transfer-accept' — pull the offer with '${cli} transfer-abort'.`,
    )
    .requiredOption('--to <imUserId>', 'IM user id of the recipient')
    .option('--json', 'Output JSON')
    .action((slugOrId: string, opts: { to: string; json?: boolean }) =>
      guard(async () => {
        const client = getIMClient();
        const ref = await refFor(client, slugOrId);
        const res = await client.im.request<LifecycleEnvelope<{ idempotent?: boolean }>>(
          'POST',
          `${base}/${encodeURIComponent(ref)}/transfer/offer`,
          { toImUserId: opts.to },
        );
        if (!res.ok) bail(res, slugOrId, 'transfer');
        if (opts.json) {
          process.stdout.write(JSON.stringify(res.data ?? {}, null, 2) + '\n');
          return;
        }
        process.stdout.write(
          `${res.data?.idempotent ? 'Transfer offer already open' : 'Transfer offered'}: ${slugOrId} -> ${opts.to}\n` +
            `  You stay the owner until they accept: ${cli} transfer-accept ${slugOrId}\n`,
        );
      }),
    );

  cmd
    .command('transfer-accept <slugOrId>')
    .description(`Accept a pending ownership offer on a ${noun} (run by the recipient).`)
    .option('--json', 'Output JSON')
    .action((slugOrId: string, opts: { json?: boolean }) =>
      guard(async () => {
        const client = getIMClient();
        const ref = await refFor(client, slugOrId);
        const res = await client.im.request<LifecycleEnvelope>(
          'POST',
          `${base}/${encodeURIComponent(ref)}/transfer/accept`,
          {},
        );
        if (!res.ok) bail(res, slugOrId, 'transfer-accept');
        if (opts.json) {
          process.stdout.write(JSON.stringify(res.data ?? {}, null, 2) + '\n');
          return;
        }
        process.stdout.write(`Ownership transferred to you: ${slugOrId}\n`);
      }),
    );

  cmd
    .command('transfer-abort <slugOrId>')
    .description(`Cancel a pending ownership offer (either side may run this).`)
    .option('--json', 'Output JSON')
    .action((slugOrId: string, opts: { json?: boolean }) =>
      guard(async () => {
        const client = getIMClient();
        const ref = await refFor(client, slugOrId);
        const res = await client.im.request<LifecycleEnvelope>(
          'POST',
          `${base}/${encodeURIComponent(ref)}/transfer/abort`,
          {},
        );
        if (!res.ok) bail(res, slugOrId, 'transfer-abort');
        if (opts.json) {
          process.stdout.write(JSON.stringify(res.data ?? {}, null, 2) + '\n');
          return;
        }
        process.stdout.write(`Transfer offer withdrawn: ${slugOrId}\n`);
      }),
    );

  // ── published — the owner's publication inventory (21 §2.7) ───────────────
  cmd
    .command('published')
    .description(
      `List every ${noun} you have published, with its listing state and how many ${consumerNoun}s depend on it (GET ${base}/mine/published).`,
    )
    .option('--json', 'Output JSON')
    .action((opts: { json?: boolean }) =>
      guard(async () => {
        const client = getIMClient();
        const res = await client.im.request<LifecycleEnvelope<PublishedAssetRow[]>>(
          'GET',
          `${base}/mine/published`,
        );
        if (!res.ok) bail(res, '-', 'published');
        const rows = res.data ?? [];
        if (opts.json) {
          process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
          return;
        }
        process.stdout.write(`Published ${noun}s (${rows.length})\n`);
        if (rows.length === 0) {
          process.stdout.write(`  Nothing published yet. Publish one: ${cli} publish <slug>\n`);
          return;
        }
        for (const r of publishedTableRows(rows)) {
          process.stdout.write(
            `  ${r.slug}\tstate=${r.state}\tconsumers=${r.consumers}\tinstalls=${r.installs}\ttransfer=${r.transfer}\n`,
          );
        }
        process.stdout.write(`  consumers = live ${consumerNoun}s that would be unbound by '${cli} archive'.\n`);
      }),
    );
}
