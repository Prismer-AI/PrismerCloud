import { Command } from 'commander';
import { PrismerClient } from '../index';

type ClientFactory = () => PrismerClient;

function padEnd(str: string, len: number): string {
  if (str.length >= len) return str.slice(0, len);
  return str + ' '.repeat(len - str.length);
}

function formatTable(rows: string[][]): string {
  if (rows.length === 0) return '';
  const cols = rows[0].length;
  const widths: number[] = Array(cols).fill(0);
  for (const row of rows) {
    for (let i = 0; i < cols; i++) {
      widths[i] = Math.max(widths[i], (row[i] ?? '').length);
    }
  }
  return rows
    .map(row => row.map((cell, i) => padEnd(cell ?? '', widths[i])).join('  '))
    .join('\n');
}

export function register(parent: Command, getIMClient: ClientFactory, _getAPIClient: ClientFactory): void {
  const skill = parent
    .command('skill')
    .description('Browse, install, and manage skills');

  // skill find [query]
  skill
    .command('find [query]')
    .description('Search the skill marketplace')
    .option('-c, --category <category>', 'filter by category')
    .option('-n, --limit <n>', 'max results to return', '20')
    .option('--json', 'output raw JSON response')
    .action(async (query: string | undefined, opts: { category?: string; limit: string; json: boolean }) => {
      const client = getIMClient();
      try {
        const limit = parseInt(opts.limit, 10);
        const res = await client.im.evolution.searchSkills({
          query,
          category: opts.category,
          limit,
        });

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        const skills: unknown[] = Array.isArray(res) ? res : ((res as { skills?: unknown[] })?.skills ?? []);
        if (skills.length === 0) {
          process.stdout.write('No skills found.\n');
          return;
        }

        const header = ['Slug', 'Name', 'Installs', 'Category'];
        const rows = skills.map((s: unknown) => {
          const sk = s as Record<string, unknown>;
          return [
            String(sk.slug ?? sk.id ?? ''),
            String(sk.name ?? ''),
            String(sk.installCount ?? sk.installs ?? '0'),
            String(sk.category ?? ''),
          ];
        });

        process.stdout.write(formatTable([header, ...rows]) + '\n');
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  // skill install <slug>
  skill
    .command('install <slug>')
    .description('Install a skill')
    .option('--platform <platform>', 'target platform: claude-code, openclaw, opencode, or all', 'all')
    .option('--project <path>', 'project directory for local file writes')
    .option('--no-local', 'cloud-only install, do not write local files')
    .option('--json', 'output raw JSON response')
    .action(async (slug: string, opts: { platform: string; project?: string; local: boolean; json: boolean }) => {
      const client = getIMClient();
      try {
        let res: unknown;
        if (!opts.local) {
          res = await client.im.evolution.installSkill(slug);
        } else {
          const platforms = opts.platform === 'all'
            ? undefined
            : [opts.platform] as string[];
          res = await client.im.evolution.installSkillLocal(slug, {
            platforms,
            project: opts.project,
          });
        }

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        const result = res as { ok?: boolean; data?: { skill?: Record<string, unknown>; localPaths?: string[] } };
        if (result?.ok === false) {
          process.stderr.write(`Install failed.\n`);
          process.exit(1);
        }

        const skillData = result?.data?.skill ?? {};
        const name = String((skillData as Record<string, unknown>).name ?? slug);
        process.stdout.write(`Installed: ${name}\n`);

        const localPaths: string[] = result?.data?.localPaths ?? [];
        if (localPaths.length > 0) {
          process.stdout.write('Local files written:\n');
          for (const p of localPaths) {
            process.stdout.write(`  ${p}\n`);
          }
        } else if (!opts.local) {
          process.stdout.write('Cloud-only install complete (no local files written).\n');
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  // skill list
  skill
    .command('list')
    .description('List installed skills')
    .option('--json', 'output raw JSON response')
    .action(async (opts: { json: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.evolution.installedSkills();

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        const records: unknown[] = Array.isArray(res) ? res : ((res as { skills?: unknown[] })?.skills ?? []);
        if (records.length === 0) {
          process.stdout.write('No skills installed.\n');
          return;
        }

        const header = ['Slug', 'Name', 'Installs', 'Category'];
        const rows = records.map((r: unknown) => {
          const rec = r as Record<string, unknown>;
          const sk = (rec.skill ?? rec) as Record<string, unknown>;
          return [
            String(sk.slug ?? sk.id ?? ''),
            String(sk.name ?? ''),
            String(sk.installCount ?? sk.installs ?? '0'),
            String(sk.category ?? ''),
          ];
        });

        process.stdout.write(formatTable([header, ...rows]) + '\n');
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  // skill show <slug>
  skill
    .command('show <slug>')
    .description('Show skill content and details')
    .option('--json', 'output raw JSON response')
    .action(async (slug: string, opts: { json: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.evolution.getSkillContent(slug);

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        const result = res as { content?: string; files?: string[]; packageUrl?: string; checksum?: string };
        if (result?.packageUrl) {
          process.stdout.write(`Package URL: ${result.packageUrl}\n`);
        }
        if (result?.checksum) {
          process.stdout.write(`Checksum:    ${result.checksum}\n`);
        }
        if (result?.files && result.files.length > 0) {
          process.stdout.write(`Files:\n`);
          for (const f of result.files) {
            process.stdout.write(`  ${f}\n`);
          }
        }
        if (result?.content) {
          process.stdout.write(`\n${result.content}\n`);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  // skill uninstall <slug>
  skill
    .command('uninstall <slug>')
    .description('Uninstall a skill')
    .option('--no-local', 'cloud-only uninstall, do not remove local files')
    .option('--json', 'output raw JSON response')
    .action(async (slug: string, opts: { local: boolean; json: boolean }) => {
      const client = getIMClient();
      try {
        let res: unknown;
        if (!opts.local) {
          res = await (client.im.evolution as unknown as Record<string, (s: string) => Promise<unknown>>).uninstallSkill(slug);
        } else {
          res = await client.im.evolution.uninstallSkillLocal(slug);
        }

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        const result = res as { ok?: boolean; data?: { uninstalled?: boolean; removedPaths?: string[] } };
        if (result?.ok === false) {
          process.stderr.write(`Uninstall failed.\n`);
          process.exit(1);
        }

        process.stdout.write(`Uninstalled: ${slug}\n`);

        const removedPaths: string[] = result?.data?.removedPaths ?? [];
        if (removedPaths.length > 0) {
          process.stdout.write('Local files removed:\n');
          for (const p of removedPaths) {
            process.stdout.write(`  ${p}\n`);
          }
        } else if (!opts.local) {
          process.stdout.write('Cloud-only uninstall complete (no local files removed).\n');
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  // skill sync
  skill
    .command('sync')
    .description('Re-sync all installed skills to local filesystem')
    .option('--platform <platform>', 'target platform: claude-code, openclaw, opencode, or all', 'all')
    .option('--json', 'output raw JSON response')
    .action(async (opts: { platform: string; json: boolean }) => {
      const client = getIMClient();
      try {
        const platforms = opts.platform === 'all'
          ? undefined
          : [opts.platform] as string[];
        const res = await client.im.evolution.syncSkillsLocal({ platforms });

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        const result = res as { synced?: number; failed?: number; paths?: string[] };
        const synced = result?.synced ?? 0;
        const failed = result?.failed ?? 0;
        process.stdout.write(`Synced: ${synced} skill(s)`);
        if (failed > 0) {
          process.stdout.write(`, failed: ${failed}`);
        }
        process.stdout.write('\n');

        const paths: string[] = result?.paths ?? [];
        if (paths.length > 0) {
          process.stdout.write('Files written:\n');
          for (const p of paths) {
            process.stdout.write(`  ${p}\n`);
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });
}
