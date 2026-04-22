/**
 * Prismer Runtime — Installed agents registry.
 *
 * Tracks which agents prismer has installed, including version, source, and
 * install metadata. Source of truth for `prismer agent list`, `install`, and
 * `uninstall`. Replaces the per-agent `.version` sidecar file as the canonical
 * store (the sidecar is still written for backward compat).
 *
 * On-disk format: JSON at `~/.prismer/agents.json`.
 *
 * Atomic write: tmp + rename — a crashed write never leaves the file
 * half-truncated. Corrupt file returns [] (not throw).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface InstalledAgent {
  /** Catalog key: 'claude-code', 'codex', etc. */
  name: string;
  displayName: string;
  /** Semver string, or 'unknown'. */
  version: string;
  source: 'cdn' | 'mirror' | 'npm';
  /** ISO 8601 */
  installedAt: string;
  /** Actual path written to. */
  hookConfigPath: string;
  sandboxProfilePath?: string;
  hookBackupPath?: string;
  signatureVerified?: boolean;
}

// ============================================================
// Path helpers
// ============================================================

export function agentsRegistryPath(homeDir: string): string {
  return path.join(homeDir, '.prismer', 'agents.json');
}

// ============================================================
// Read / Write (atomic)
// ============================================================

export function readAgentsRegistry(homeDir: string): InstalledAgent[] {
  const file = agentsRegistryPath(homeDir);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    // Any other read error (permissions, etc.) — be tolerant
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: InstalledAgent[] = [];
    for (const row of parsed) {
      if (!row || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      if (typeof r.name !== 'string' || typeof r.hookConfigPath !== 'string') continue;
      out.push({
        name: r.name,
        displayName: typeof r.displayName === 'string' ? r.displayName : r.name,
        version: typeof r.version === 'string' ? r.version : 'unknown',
        source: (r.source === 'cdn' || r.source === 'mirror' || r.source === 'npm') ? r.source : 'npm',
        installedAt: typeof r.installedAt === 'string' ? r.installedAt : new Date(0).toISOString(),
        hookConfigPath: r.hookConfigPath,
        sandboxProfilePath: typeof r.sandboxProfilePath === 'string' ? r.sandboxProfilePath : undefined,
        hookBackupPath: typeof r.hookBackupPath === 'string' ? r.hookBackupPath : undefined,
        signatureVerified: typeof r.signatureVerified === 'boolean' ? r.signatureVerified : undefined,
      });
    }
    return out;
  } catch {
    // Corrupt JSON — return empty, let install recover
    return [];
  }
}

export function writeAgentsRegistry(homeDir: string, agents: InstalledAgent[]): void {
  const file = agentsRegistryPath(homeDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(agents, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ============================================================
// Mutators
// ============================================================

export function upsertAgent(homeDir: string, agent: InstalledAgent): void {
  const all = readAgentsRegistry(homeDir);
  const idx = all.findIndex((a) => a.name === agent.name);
  if (idx >= 0) {
    all[idx] = agent;
  } else {
    all.push(agent);
  }
  writeAgentsRegistry(homeDir, all);
}

export function removeAgent(homeDir: string, name: string): void {
  const all = readAgentsRegistry(homeDir);
  const filtered = all.filter((a) => a.name !== name);
  if (filtered.length !== all.length) {
    writeAgentsRegistry(homeDir, filtered);
  }
}

export function findAgent(homeDir: string, name: string): InstalledAgent | undefined {
  return readAgentsRegistry(homeDir).find((a) => a.name === name);
}
