/**
 * `cloud skill draft` — release201/07 skill-authoring engine CLI.
 *
 * Subcommands:
 *   cloud skill draft create --slug <s> --manifest <path-to-manifest.json>
 *   cloud skill draft patch  <draft-id> --file <path> --op add|update|delete [--content <text>]
 *   cloud skill draft regenerate <draft-id> --reason "<text>"
 *   cloud skill draft show <draft-id>
 *   cloud skill draft list --workspace <wsId>
 *
 * The manifest.json read by `create` follows release201/07 §2.4 — a JSON
 * document of the form:
 *
 *   {
 *     "slug": "...",
 *     "name": "...",
 *     "description": "...",
 *     "workspaceId": "...",
 *     "ownerAgentId": "...",
 *     "files": [
 *       { "path": "SKILL.md", "content": "<utf-8 text>" },
 *       { "path": "skill.json", "content": "<utf-8 text>" }
 *     ],
 *     "metadata": { "authoring": { "sourceKind": "doc-url", "sourceRefs": [...] } }
 *   }
 *
 * Files may carry either `content` (utf-8) or `contentBase64` (binary).
 */

import { Command } from 'commander';
import * as fs from 'fs';
import { PrismerClient } from '../index';

type ClientFactory = () => PrismerClient;

export function register(parent: Command, getIMClient: ClientFactory, _getAPIClient: ClientFactory): void {
  const skill = parent.commands.find((c) => c.name() === 'skill') ?? parent.command('skill');
  const draft = skill
    .command('draft')
    .description('Author / patch / regenerate / show / list skill drafts (release201/07)');

  // ─── cloud skill draft create ────────────────────────────
  draft
    .command('create')
    .description('Submit a new skill draft from a manifest.json file')
    .option('--slug <slug>', 'Draft slug (overrides manifest.slug)')
    .option('--manifest <path>', 'Path to manifest.json containing slug/name/description/files[]/...')
    .option('--workspace <id>', 'Override manifest.workspaceId')
    .option('--owner-agent <id>', 'Override manifest.ownerAgentId')
    .option('--json', 'Output raw JSON response')
    .action(async (opts: { slug?: string; manifest?: string; workspace?: string; ownerAgent?: string; json?: boolean }) => {
      if (!opts.manifest) {
        process.stderr.write('Error: --manifest <path-to-manifest.json> is required\n');
        process.exit(1);
      }
      let manifest: any;
      try {
        manifest = JSON.parse(fs.readFileSync(opts.manifest, 'utf-8'));
      } catch (err) {
        process.stderr.write(`Error: failed to read manifest ${opts.manifest}: ${(err as Error).message}\n`);
        process.exit(1);
      }
      const slug = opts.slug ?? manifest.slug;
      const workspaceId = opts.workspace ?? manifest.workspaceId;
      const ownerAgentId = opts.ownerAgent ?? manifest.ownerAgentId;
      if (!slug || !manifest.name || !manifest.description) {
        process.stderr.write('Error: manifest must include slug, name, description\n');
        process.exit(1);
      }
      if (!workspaceId) {
        process.stderr.write('Error: --workspace <id> or manifest.workspaceId is required\n');
        process.exit(1);
      }
      if (!Array.isArray(manifest.files) || manifest.files.length < 2) {
        process.stderr.write('Error: manifest.files[] must include at least SKILL.md + skill.json\n');
        process.exit(1);
      }

      const client = getIMClient();
      try {
        const res = await client.im.skills.draft.create({
          slug,
          name: manifest.name,
          description: manifest.description,
          workspaceId,
          ownerAgentId,
          files: manifest.files,
          metadata: manifest.metadata,
        });
        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }
        if (!res.ok) {
          process.stderr.write(`Error: ${(res as any).error ?? 'create failed'}\n`);
          process.exit(1);
        }
        const data: any = (res as any).data ?? res;
        process.stdout.write(`Draft submitted.\n`);
        process.stdout.write(`  id:                ${data.id}\n`);
        process.stdout.write(`  slug:              ${data.slug}\n`);
        process.stdout.write(`  manifest revision: ${data.manifestRevision}\n`);
        if (data.reviewTaskId) {
          process.stdout.write(`  review task:       ${data.reviewTaskId}\n`);
        }
        const warnings: Array<{ gate: string; message: string }> = data.validationWarnings ?? [];
        if (warnings.length > 0) {
          process.stdout.write(`  warnings:\n`);
          for (const w of warnings) {
            process.stdout.write(`    [${w.gate}] ${w.message}\n`);
          }
        }
      } catch (err) {
        process.stderr.write(`Error: ${(err as Error).message}\n`);
        process.exit(1);
      }
    });

  // ─── cloud skill draft patch ────────────────────────────
  draft
    .command('patch <draft-id>')
    .description('Patch a draft — add / update / delete a single file')
    .option('--file <path>', 'Manifest file path inside the draft (e.g. SKILL.md or references/foo.md)')
    .option('--op <op>', 'Operation: add | update | delete', 'update')
    .option('--content <text>', 'New utf-8 content for add/update (omit for --content-file)')
    .option('--content-file <path>', 'Read content from a local file')
    .option('--reason <text>', 'Free-form reason recorded in revision history')
    .option('--json', 'Output raw JSON response')
    .action(async (
      draftId: string,
      opts: { file?: string; op: string; content?: string; contentFile?: string; reason?: string; json?: boolean },
    ) => {
      if (!opts.file) {
        process.stderr.write('Error: --file <path> is required\n');
        process.exit(1);
      }
      if (!['add', 'update', 'delete'].includes(opts.op)) {
        process.stderr.write(`Error: --op must be add | update | delete (got ${opts.op})\n`);
        process.exit(1);
      }
      let content: string | undefined;
      if (opts.op !== 'delete') {
        if (opts.contentFile) {
          try {
            content = fs.readFileSync(opts.contentFile, 'utf-8');
          } catch (err) {
            process.stderr.write(`Error: failed to read --content-file: ${(err as Error).message}\n`);
            process.exit(1);
          }
        } else if (opts.content !== undefined) {
          content = opts.content;
        } else {
          process.stderr.write('Error: --content or --content-file is required for add/update\n');
          process.exit(1);
        }
      }

      const client = getIMClient();
      try {
        const res = await client.im.skills.draft.patch(draftId, {
          files: [{ path: opts.file, op: opts.op as 'add' | 'update' | 'delete', content }],
          reason: opts.reason,
        });
        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }
        if (!res.ok) {
          process.stderr.write(`Error: ${(res as any).error ?? 'patch failed'}\n`);
          process.exit(1);
        }
        const data: any = (res as any).data ?? res;
        process.stdout.write(`Patch applied.\n`);
        process.stdout.write(`  id:                ${data.id}\n`);
        process.stdout.write(`  manifest revision: ${data.manifestRevision}\n`);
      } catch (err) {
        process.stderr.write(`Error: ${(err as Error).message}\n`);
        process.exit(1);
      }
    });

  // ─── cloud skill draft regenerate ────────────────────────
  draft
    .command('regenerate <draft-id>')
    .description('Request a regenerate session for a draft (does not delete current manifest)')
    .option('--reason <text>', 'Why the draft needs regeneration')
    .option('--json', 'Output raw JSON response')
    .action(async (draftId: string, opts: { reason?: string; json?: boolean }) => {
      if (!opts.reason) {
        process.stderr.write('Error: --reason <text> is required\n');
        process.exit(1);
      }
      const client = getIMClient();
      try {
        const res = await client.im.skills.draft.regenerate(draftId, { reason: opts.reason });
        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }
        if (!res.ok) {
          process.stderr.write(`Error: ${(res as any).error ?? 'regenerate failed'}\n`);
          process.exit(1);
        }
        const data: any = (res as any).data ?? res;
        process.stdout.write(`Regenerate requested.\n`);
        process.stdout.write(`  id:         ${data.id}\n`);
        process.stdout.write(`  session id: ${data.sessionId}\n`);
      } catch (err) {
        process.stderr.write(`Error: ${(err as Error).message}\n`);
        process.exit(1);
      }
    });

  // ─── cloud skill draft show ────────────────────────────
  draft
    .command('show <draft-id>')
    .description('Show a draft\'s manifest + revision history')
    .option('--json', 'Output raw JSON response')
    .action(async (draftId: string, opts: { json?: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.skills.draft.show(draftId);
        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }
        if (!res.ok) {
          process.stderr.write(`Error: ${(res as any).error ?? 'show failed'}\n`);
          process.exit(1);
        }
        const data: any = (res as any).data ?? res;
        process.stdout.write(`Draft ${data.id}\n`);
        process.stdout.write(`  slug:        ${data.slug}\n`);
        process.stdout.write(`  name:        ${data.name}\n`);
        process.stdout.write(`  status:      ${data.status}\n`);
        process.stdout.write(`  workspace:   ${data.workspaceId}\n`);
        process.stdout.write(`  ownerAgent:  ${data.ownerAgentId}\n`);
        process.stdout.write(`  revision:    ${data.manifestRevision}\n`);
        process.stdout.write(`  license:     ${data.license}\n`);
        process.stdout.write(`  compatibility: ${(data.compatibility ?? []).join(', ')}\n`);
        process.stdout.write(`  files:\n`);
        for (const f of (data.files ?? [])) {
          process.stdout.write(`    ${f.path} (${f.size}B, sha256:${(f.sha256 ?? '').slice(0, 8)}…)\n`);
        }
      } catch (err) {
        process.stderr.write(`Error: ${(err as Error).message}\n`);
        process.exit(1);
      }
    });

  // ─── cloud skill draft list ────────────────────────────
  draft
    .command('list')
    .description('List drafts in a workspace')
    .option('--workspace <id>', 'Workspace id (required)')
    .option('--json', 'Output raw JSON response')
    .action(async (opts: { workspace?: string; json?: boolean }) => {
      if (!opts.workspace) {
        process.stderr.write('Error: --workspace <id> is required\n');
        process.exit(1);
      }
      const client = getIMClient();
      try {
        const res = await client.im.skills.draft.list(opts.workspace);
        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }
        if (!res.ok) {
          process.stderr.write(`Error: ${(res as any).error ?? 'list failed'}\n`);
          process.exit(1);
        }
        const drafts: any[] = (res as any).data ?? [];
        if (drafts.length === 0) {
          process.stdout.write('No drafts in this workspace.\n');
          return;
        }
        process.stdout.write(`Drafts (${drafts.length}):\n`);
        for (const d of drafts) {
          process.stdout.write(`  ${d.id}  ${d.slug}  ${(d.name ?? '').slice(0, 32)}  rev:${(d.contentManifestRevision ?? '').slice(0, 8)}…  updated:${d.updatedAt}\n`);
        }
      } catch (err) {
        process.stderr.write(`Error: ${(err as Error).message}\n`);
        process.exit(1);
      }
    });
}
