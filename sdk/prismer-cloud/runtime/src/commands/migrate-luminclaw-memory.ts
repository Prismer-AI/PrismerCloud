// Luminclaw Memory Migration Tool — Import luminclaw local memory to Memory Gateway
//
// This command scans {workspace}/.prismer/memory/ for daily memory files,
// parses them, and imports them into im_memory_files (cloud MySQL via API).

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { CliContext } from '../cli/context.js';
import { resolveDaemonIdentity } from './daemon.js';

// ============================================================
// Types
// ============================================================

interface LuminclawMemoryEntry {
  date: string;
  type: 'episodic' | 'semantic' | 'project';
  content: string;
  tags?: string[];
}

interface MigrationResult {
  workspace: string;
  scannedFiles: number;
  importedEntries: number;
  skippedFiles: number;
  errors: string[];
}

// ============================================================
// Constants
// ============================================================

const MIGRATED_MARKER_FILE = 'MIGRATED.md';

function cloudMemoryApiUrl(identity: { cloudApiBase?: string }): string {
  if (process.env['MEMORY_API_URL']) return process.env['MEMORY_API_URL'];
  const base = identity.cloudApiBase ?? 'https://prismer.cloud';
  return `${base.replace(/\/+$/, '')}/api/v1/memory/write`;
}

// ============================================================
// Luminclaw Memory Parser
// ============================================================

function parseLuminclawMemoryFile(
  content: string,
  filePath: string,
): LuminclawMemoryEntry[] {
  const entries: LuminclawMemoryEntry[] = [];
  const lines = content.split('\n');
  const date = extractDateFromFileName(filePath);

  let currentType: 'episodic' | 'semantic' | 'project' = 'episodic';
  let currentContent: string[] = [];
  let currentTags: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Type detection
    const typeMatch = trimmed.match(/^##\s*(\w+)$/);
    if (typeMatch) {
      // Flush previous entry if exists
      if (currentContent.length > 0) {
        entries.push({
          date,
          type: currentType,
          content: currentContent.join('\n'),
          tags: currentTags.length > 0 ? currentTags : undefined,
        });
      }
      currentType = typeMatch[1] as any;
      currentContent = [];
      currentTags = [];
      continue;
    }

    // Tag detection
    const tagMatch = trimmed.match(/^tags:\s*(.+)$/);
    if (tagMatch) {
      currentTags = tagMatch[1].split(',').map(t => t.trim());
      continue;
    }

    // Content
    currentContent.push(trimmed);
  }

  // Flush last entry
  if (currentContent.length > 0) {
    entries.push({
      date,
      type: currentType,
      content: currentContent.join('\n'),
      tags: currentTags.length > 0 ? currentTags : undefined,
    });
  }

  return entries;
}

function extractDateFromFileName(filePath: string): string {
  const filename = path.basename(filePath);
  const match = filename.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : new Date().toISOString().split('T')[0];
}

// ============================================================
// Migration Logic
// ============================================================

async function scanWorkspace(workspace: string): Promise<string[]> {
  const memoryDir = path.join(workspace, '.prismer', 'memory');

  if (!fs.existsSync(memoryDir)) {
    return [];
  }

  const files = await fs.promises.readdir(memoryDir);
  return files
    .filter(f => f.endsWith('.md') && f !== MIGRATED_MARKER_FILE)
    .map(f => path.join(memoryDir, f));
}

async function checkMigratedMarker(workspace: string): Promise<boolean> {
  const markerPath = path.join(workspace, '.prismer', 'memory', MIGRATED_MARKER_FILE);
  return fs.existsSync(markerPath);
}

async function writeMigratedMarker(
  workspace: string,
  result: MigrationResult,
): Promise<void> {
  const markerPath = path.join(workspace, '.prismer', 'memory', MIGRATED_MARKER_FILE);
  const marker = `# Luminclaw Memory Migration\n\n` +
    `Migrated on: ${new Date().toISOString()}\n\n` +
    `# Migration Summary\n` +
    `- Scanned files: ${result.scannedFiles}\n` +
    `- Imported entries: ${result.importedEntries}\n` +
    `- Skipped files: ${result.skippedFiles}\n` +
    `- Errors: ${result.errors.length}\n\n` +
    `# Note\n` +
    `This marker prevents future re-migration. To re-migrate,\n` +
    `delete this file and run \`prismer migrate luminclaw-memory\` again.\n`;

  await fs.promises.writeFile(markerPath, marker, 'utf-8');
}

async function importToCloud(
  entry: LuminclawMemoryEntry,
  fetchImpl: typeof fetch,
  apiKey: string,
  apiUrl: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const resp = await fetchImpl(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        memoryType: entry.type,
        description: entry.content.slice(0, 500), // Truncate description
        content: entry.content,
        scope: 'user',
        originAdapter: 'luminclaw',
        importedAt: new Date().toISOString(),
        metadata: entry.tags ? { tags: entry.tags } : undefined,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      return { success: false, error: `HTTP ${resp.status}: ${errorText}` };
    }

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

async function migrateWorkspace(
  workspace: string,
  fetchImpl: typeof fetch,
  ctx: CliContext,
  apiKey: string,
  identity: { cloudApiBase?: string },
): Promise<MigrationResult> {
  const result: MigrationResult = {
    workspace,
    scannedFiles: 0,
    importedEntries: 0,
    skippedFiles: 0,
    errors: [],
  };

  const apiUrl = cloudMemoryApiUrl(identity);

  // Check if already migrated
  if (await checkMigratedMarker(workspace)) {
    ctx.ui.warn('Memory already migrated', 'Delete MIGRATED.md to re-migrate');
    result.skippedFiles = 1;
    return result;
  }

  // Scan for memory files
  const memoryFiles = await scanWorkspace(workspace);
  result.scannedFiles = memoryFiles.length;

  if (memoryFiles.length === 0) {
    ctx.ui.secondary('No luminclaw memory files found in workspace');
    return result;
  }

  // §15.4 long-op progress bar — file count is our unit because entries/file
  // varies unpredictably and the wall-clock cost dominates on imports, not
  // parsing.
  const bar = ctx.ui.progress('Importing luminclaw memory', memoryFiles.length);
  let done = 0;

  for (const filePath of memoryFiles) {
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const entries = parseLuminclawMemoryFile(content, filePath);

      for (const entry of entries) {
        const importResult = await importToCloud(entry, fetchImpl, apiKey, apiUrl);

        if (importResult.success) {
          result.importedEntries++;
        } else {
          result.errors.push(`${path.basename(filePath)}: ${importResult.error}`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`${path.basename(filePath)}: ${message}`);
    }

    done += 1;
    bar.update(done, `${done}/${memoryFiles.length} · ${result.importedEntries} entries`);
  }

  bar.stop(`Imported ${result.importedEntries} entries from ${memoryFiles.length} files`);

  // Write migration marker
  if (result.importedEntries > 0) {
    await writeMigratedMarker(workspace, result);
  }

  return result;
}

// ============================================================
// Exported function
// ============================================================

export async function migrateLuminclawMemoryCommand(
  ctx: CliContext,
  opts: {
    workspace?: string;
    dryRun?: boolean;
    force?: boolean;
    identity?: { apiKey?: string; cloudApiBase?: string };  // test injection
    fetchImpl?: typeof fetch;                                // test injection
  },
): Promise<number> {
  const workspace = opts.workspace ?? process.cwd();
  const dryRun = opts.dryRun ?? false;

  ctx.ui.header('Luminclaw Memory Migration');
  ctx.ui.secondary(`Workspace: ${workspace}`);
  ctx.ui.blank();

  if (dryRun) {
    ctx.ui.line('DRY RUN mode — no actual migration will be performed');
    const memoryFiles = await scanWorkspace(workspace);
    ctx.ui.line(`Found ${memoryFiles.length} memory files to migrate`);
    ctx.ui.line('Run without --dry-run to perform actual migration');
    return 0;
  }

  // Resolve identity — config-file > env > undefined fallback
  const identity = opts.identity ?? await resolveDaemonIdentity();
  const apiKey = identity.apiKey;

  // Fail fast: no point scanning files if we can't authenticate
  if (!apiKey) {
    ctx.ui.error(
      'No API key configured',
      'Cannot import to cloud without authentication',
      'Run: prismer setup <sk-prismer-...>',
    );
    return 1;
  }

  const fetchImpl = opts.fetchImpl ?? fetch;

  try {
    const result = await migrateWorkspace(workspace, fetchImpl, ctx, apiKey, identity);

    ctx.ui.blank();
    ctx.ui.line('Migration Summary:');
    ctx.ui.line(`  Scanned files: ${result.scannedFiles}`);
    ctx.ui.line(`  Imported entries: ${result.importedEntries}`);
    ctx.ui.line(`  Skipped files: ${result.skippedFiles}`);
    ctx.ui.line(`  Errors: ${result.errors.length}`);

    if (result.errors.length > 0) {
      ctx.ui.line('');
      ctx.ui.fail('Migration completed with errors');
      for (const error of result.errors) {
        ctx.ui.secondary(`  - ${error}`);
      }
      return 1;
    }

    ctx.ui.success('Migration completed successfully');
    ctx.ui.secondary('Original memory files are preserved at .prismer/memory/');
    return 0;
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    ctx.ui.error(e.message, e.stack);
    return 1;
  }
}
