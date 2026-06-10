// `prismer adapter (list|install|remove|info)` — adapter inventory + downstream
// CLI lifecycle.
//
// In 1.9.x the adapter *implementations* (the AdapterDef objects) ship inside
// @prismer/runtime — there is no plugin loader. What `install` does is install
// the *downstream binary* the adapter wraps. Examples:
//
//   prismer adapter install claude-code  → npm install -g @anthropic-ai/claude-code
//   prismer adapter install openclaw     → npm install -g openclaw
//   prismer adapter install codex        → npm install -g @openai/codex
//   prismer adapter install hermes       → pipx install hermes-llm  (Python tool)
//
// On success we record the resolved binary path + version into
// ~/.prismer/config.toml under [adapters.<name>] so subsequent `adapter list`
// + `daemon start` know which adapter is locally executable.

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
import { claudeCodeAdapter } from '../../adapters/claude-code/index.js';
import { codexAdapter } from '../../adapters/codex/index.js';
import { hermesAdapter } from '../../adapters/hermes/index.js';
import { openclawAdapter } from '../../adapters/openclaw/index.js';
import { configExists, loadConfig, resolvePaths, saveConfig, type Config } from '../../config.js';
import { exitWithError, printJson } from '../util.js';
import { getUI } from '../ui.js';

const BUILTIN_ADAPTERS = [hermesAdapter, claudeCodeAdapter, openclawAdapter, codexAdapter];

/** Downstream binary an adapter wraps. */
interface AdapterInstallSpec {
  /** Adapter name (matches AdapterDef.name). */
  name: string;
  /** Package manager that ships the downstream CLI. */
  manager: 'npm' | 'pipx' | 'pip';
  /** Package name as known to the manager. */
  package: string;
  /** Binary to look up on PATH after install (used for verify + version). */
  binary: string;
  /** Args to print the version (default: --version). */
  versionArgs?: string[];
  /** Optional post-install hint (env vars, gateway start command, etc.). */
  hint?: string;
  /** Env vars or auth files operators commonly need before dispatch works. */
  authHints?: string[];
  /** Hook config file or directory used by this downstream CLI. */
  hookTarget?: AdapterHookTarget;
}

interface AdapterHookTarget {
  path: string;
  kind: 'json-file' | 'directory';
}

const INSTALL_SPECS: Record<string, AdapterInstallSpec> = {
  'claude-code': {
    name: 'claude-code',
    manager: 'npm',
    package: '@anthropic-ai/claude-code',
    binary: 'claude',
    hint:
      'Set ANTHROPIC_API_KEY in your shell profile, or rely on Claude Code OAuth login. ' +
      'Run `claude login` to sign in.',
    authHints: ['ANTHROPIC_API_KEY or Claude Code OAuth login (`claude login`)'],
    hookTarget: { path: join(homedir(), '.claude', 'hooks.json'), kind: 'json-file' },
  },
  openclaw: {
    name: 'openclaw',
    manager: 'npm',
    package: 'openclaw',
    binary: 'openclaw',
    hint:
      'OpenClaw runs as a gateway. Configure ~/.openclaw/openclaw.json and start it ' +
      'with `openclaw gateway` before tasks dispatch.',
    authHints: ['~/.openclaw/openclaw.json gateway.auth.bearerTokens', 'Prismer daemon api_key'],
    hookTarget: { path: join(homedir(), '.openclaw', 'hooks'), kind: 'directory' },
  },
  codex: {
    name: 'codex',
    manager: 'npm',
    package: '@openai/codex',
    binary: 'codex',
    hint: 'Set OPENAI_API_KEY in your shell profile. Verify with `codex --help`.',
    authHints: ['OPENAI_API_KEY or Codex CLI account login'],
    hookTarget: { path: join(homedir(), '.codex', 'hooks.json'), kind: 'json-file' },
  },
  hermes: {
    name: 'hermes',
    manager: 'pipx',
    package: 'hermes-llm',
    binary: 'hermes',
    hint:
      'Hermes runs as a long-lived HTTP gateway in your own Python venv. ' +
      'Start with `hermes -p <profile> gateway` after configuring ~/.hermes/.env.',
    authHints: ['~/.hermes/.env API_SERVER_KEY', 'Hermes profile provider credentials'],
    hookTarget: { path: join(homedir(), '.hermes', 'hooks.json'), kind: 'json-file' },
  },
};

export function buildAdapterCommand(): Command {
  const cmd = new Command('adapter').description('Adapter inventory + downstream CLI lifecycle');

  cmd
    .command('list')
    .description('List built-in adapters with their downstream CLI health + recorded version')
    .option('--json', 'Output JSON')
    .action(async () => {
      const recorded = readAdapterConfig();
      const out = await Promise.all(
        BUILTIN_ADAPTERS.map(async (a) => ({
          name: a.name,
          kind: a.kind,
          capabilities: a.capabilities,
          health: await a.health(),
          installed: recorded[a.name] ?? null,
        })),
      );
      const ui = getUI();
      ui.result(
        () => {
          ui.header('Adapters');
          ui.blank();
          ui.table(
            out.map((a) => ({
              name: a.name,
              kind: a.kind,
              health: a.health.available ? '● available' : '○ missing',
              installed: a.installed?.version ?? a.installed?.path ? String(a.installed?.version ?? '✓') : '—',
              capabilities: a.capabilities.join(', '),
            })),
            { columns: ['name', 'kind', 'health', 'installed', 'capabilities'] },
          );
        },
        out,
      );
    });

  cmd
    .command('install <name>')
    .description('Install the downstream CLI a built-in adapter wraps (npm or pipx)')
    .option('--package-version <ver>', 'Version spec (default: latest)', 'latest')
    .option('--with-hooks', 'Also install a Prismer hook marker into the downstream hook config', false)
    .option('--dry-run', 'Print the command that would run, but do not execute', false)
    .option('--json', 'Accept --json for global flag compatibility (npm/pipx output is streamed live)')
    .action((name: string, opts: { packageVersion: string; withHooks?: boolean; dryRun?: boolean }) => {
      const spec = INSTALL_SPECS[name];
      if (!spec) {
        exitWithError(
          `Unknown adapter "${name}". Built-in adapters: ${Object.keys(INSTALL_SPECS).join(', ')}.`,
        );
      }
      runInstall(spec!, opts.packageVersion, opts.dryRun ?? false);
      if (opts.withHooks) runHooks(spec!, { check: false, dryRun: opts.dryRun ?? false });
    });

  cmd
    .command('remove <name>')
    .alias('uninstall')
    .description('Uninstall the downstream CLI and clear [adapters.<name>] from config.toml')
    .option('--json', 'Accept --json for global flag compatibility')
    .action((name: string) => {
      const spec = INSTALL_SPECS[name];
      if (!spec) {
        exitWithError(
          `Unknown adapter "${name}". Built-in adapters: ${Object.keys(INSTALL_SPECS).join(', ')}.`,
        );
      }
      runUninstall(spec!);
    });

  cmd
    .command('info <name>')
    .description('Print install spec + currently-recorded version for an adapter')
    .option('--json', 'Output JSON (default)')
    .action((name: string) => {
      const spec = INSTALL_SPECS[name];
      if (!spec) {
        exitWithError(
          `Unknown adapter "${name}". Built-in adapters: ${Object.keys(INSTALL_SPECS).join(', ')}.`,
        );
      }
      const recorded = readAdapterConfig()[name] ?? null;
      printJson({ spec, recorded });
    });

  cmd
    .command('doctor <name>')
    .description('Check downstream binary, adapter health, config, auth hints, and hook marker')
    .option('--json', 'Output JSON (default)')
    .action(async (name: string) => {
      const spec = INSTALL_SPECS[name];
      if (!spec) {
        exitWithError(
          `Unknown adapter "${name}". Built-in adapters: ${Object.keys(INSTALL_SPECS).join(', ')}.`,
        );
      }
      printJson(await runDoctor(spec!));
    });

  cmd
    .command('hooks <name>')
    .description('Install or check the Prismer hook marker for a downstream adapter')
    .option('--check', 'Only check whether the hook marker is present', false)
    .option('--dry-run', 'Preview the hook change without writing files', false)
    .option('--json', 'Output JSON (default)')
    .action((name: string, opts: { check?: boolean; dryRun?: boolean }) => {
      const spec = INSTALL_SPECS[name];
      if (!spec) {
        exitWithError(
          `Unknown adapter "${name}". Built-in adapters: ${Object.keys(INSTALL_SPECS).join(', ')}.`,
        );
      }
      try {
        printJson(runHooks(spec!, { check: opts.check ?? false, dryRun: opts.dryRun ?? false }));
      } catch (err) {
        exitWithError((err as Error).message);
      }
    });

  return cmd;
}

// ─────────────────────── implementation ───────────────────────────────────────

function runInstall(spec: AdapterInstallSpec, version: string, dryRun: boolean): void {
  const { argv0, args } = installCommand(spec, version);
  getUI().line(`> ${argv0} ${args.join(' ')}`);
  if (dryRun) {
    getUI().line('(dry-run — not executing)');
    return;
  }

  if (!commandExists(argv0)) {
    exitWithError(
      `${argv0} not found on PATH. Install ${spec.manager === 'npm' ? 'Node.js + npm' : 'Python + pipx'} first, or pass a tarball path.`,
    );
  }

  const result = spawnSync(argv0, args, { stdio: 'inherit', encoding: 'utf8' });
  if (result.status !== 0) {
    exitWithError(`${spec.manager} install failed (exit ${result.status ?? '?'}). See output above.`);
  }

  const binPath = whichBinary(spec.binary);
  if (!binPath) {
    exitWithError(
      `${spec.manager} succeeded but '${spec.binary}' is still not on PATH. ` +
        `You may need to restart your shell or update PATH (e.g. add npm global bin).`,
    );
  }

  const installedVersion = probeVersion(binPath!, spec.versionArgs ?? ['--version']);
  recordInstallInConfig(spec, binPath!, installedVersion ?? 'unknown');

  getUI().ok(`${spec.name} installed`, `${binPath}${installedVersion ? ` (${installedVersion})` : ''}`);
  if (spec.hint) getUI().tip(spec.hint);
}

function runUninstall(spec: AdapterInstallSpec): void {
  const argv0 = managerExecutable(spec.manager);
  const args = uninstallArgs(spec);
  getUI().line(`> ${argv0} ${args.join(' ')}`);

  if (commandExists(argv0)) {
    const result = spawnSync(argv0, args, { stdio: 'inherit', encoding: 'utf8' });
    if (result.status !== 0) {
      // Don't fail hard — the package may already be absent. Continue to clear config.
      process.stderr.write(
        `! ${spec.manager} uninstall returned exit ${result.status ?? '?'} (continuing — package may already be removed)\n`,
      );
    }
  } else {
    process.stderr.write(`! ${argv0} not found on PATH; skipping package removal\n`);
  }

  clearInstallInConfig(spec.name);
  getUI().line(`✓ cleared [adapters.${spec.name}] from config.toml`);
}

async function runDoctor(spec: AdapterInstallSpec): Promise<Record<string, unknown>> {
  const binaryPath = whichBinary(spec.binary);
  const binaryVersion = binaryPath ? probeVersion(binaryPath, spec.versionArgs ?? ['--version']) : null;
  const adapter = BUILTIN_ADAPTERS.find((a) => a.name === spec.name);
  const health = adapter ? await adapter.health() : { available: false, reason: 'adapter definition not loaded' };
  const paths = resolvePaths();
  const configFileExists = configExists(paths);
  const recorded = readAdapterConfig()[spec.name] ?? null;
  const hook = inspectHook(spec);
  const env = inspectAuthEnv(spec);
  const checks = [
    {
      name: 'downstream_binary',
      ok: Boolean(binaryPath),
      detail: binaryPath ? { binary: spec.binary, path: binaryPath, version: binaryVersion } : { binary: spec.binary },
      fix: binaryPath ? null : `prismer adapter install ${spec.name}`,
    },
    {
      name: 'adapter_health',
      ok: health.available,
      detail: health,
      fix: health.available ? null : health.hint ?? `Install and configure ${spec.name}`,
    },
    {
      name: 'recorded_config',
      ok: Boolean(recorded),
      detail: { configFile: paths.configFile, exists: configFileExists, adapter: recorded },
      fix: recorded
        ? null
        : configFileExists
          ? `prismer adapter install ${spec.name}`
          : 'prismer setup',
    },
    {
      name: 'auth_env',
      ok: env.ok,
      detail: env,
      fix: env.ok ? null : spec.hint ?? spec.authHints?.join('; ') ?? 'Configure downstream CLI auth',
    },
    {
      name: 'hook_config',
      ok: hook.markerPresent,
      detail: hook,
      fix: hook.markerPresent ? null : `prismer adapter hooks ${spec.name}`,
    },
  ];
  return {
    ok: checks.every((c) => c.ok),
    adapter: spec.name,
    checks,
    fixes: checks.filter((c) => !c.ok && c.fix).map((c) => c.fix),
  };
}

function runHooks(
  spec: AdapterInstallSpec,
  opts: { check: boolean; dryRun: boolean },
): Record<string, unknown> {
  const before = inspectHook(spec);
  if (opts.check || before.markerPresent) {
    return {
      ok: before.markerPresent,
      adapter: spec.name,
      action: opts.check ? 'check' : 'none',
      hook: before,
      fix: before.markerPresent ? null : `prismer adapter hooks ${spec.name}`,
    };
  }

  if (!spec.hookTarget) {
    return {
      ok: false,
      adapter: spec.name,
      action: 'unsupported',
      hook: before,
      fix: null,
    };
  }

  const planned = plannedHookWrite(spec);
  if (opts.dryRun) {
    return {
      ok: true,
      adapter: spec.name,
      action: 'dry-run',
      hook: before,
      planned,
    };
  }

  let backup: string | null;
  if (planned.kind === 'directory') {
    mkdirSync(planned.path, { recursive: true });
    const markerPath = join(planned.path, 'prismer.json');
    backup = backupIfExists(markerPath);
    writeFileSync(markerPath, JSON.stringify(prismerHookMarker(spec), null, 2) + '\n', 'utf8');
  } else {
    mkdirSync(dirname(planned.path), { recursive: true });
    backup = backupIfExists(planned.path);
    const merged = mergeHookJson(planned.path, spec);
    writeFileSync(planned.path, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  }

  return {
    ok: true,
    adapter: spec.name,
    action: 'installed',
    backup,
    hook: inspectHook(spec),
  };
}

function installCommand(spec: AdapterInstallSpec, version: string): { argv0: string; args: string[] } {
  const ref = version === 'latest' ? spec.package : `${spec.package}@${version}`;
  switch (spec.manager) {
    case 'npm':
      return { argv0: 'npm', args: ['install', '-g', ref] };
    case 'pipx':
      // pipx install only accepts ==pin, not @version
      const pyRef = version === 'latest' ? spec.package : `${spec.package}==${version}`;
      return { argv0: 'pipx', args: ['install', pyRef] };
    case 'pip':
      const pipRef = version === 'latest' ? spec.package : `${spec.package}==${version}`;
      return { argv0: 'pip', args: ['install', '--user', pipRef] };
  }
}

function uninstallArgs(spec: AdapterInstallSpec): string[] {
  switch (spec.manager) {
    case 'npm':
      return ['uninstall', '-g', spec.package];
    case 'pipx':
      return ['uninstall', spec.package];
    case 'pip':
      return ['uninstall', '-y', spec.package];
  }
}

function managerExecutable(m: 'npm' | 'pipx' | 'pip'): string {
  return m;
}

function commandExists(bin: string): boolean {
  // POSIX-only — `command -v` works in any sh/bash/zsh. Avoid `which` (BSD vs GNU drift).
  const r = spawnSync('command', ['-v', bin], { encoding: 'utf8', shell: true });
  return r.status === 0 && (r.stdout ?? '').trim().length > 0;
}

function whichBinary(bin: string): string | null {
  const r = spawnSync('command', ['-v', bin], { encoding: 'utf8', shell: true });
  if (r.status !== 0) return null;
  const out = (r.stdout ?? '').trim();
  return out.length > 0 ? out : null;
}

function probeVersion(bin: string, args: string[]): string | null {
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  // Take the first non-empty line; many tools print "<name> 1.2.3" or similar.
  return out.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? null;
}

function inspectAuthEnv(spec: AdapterInstallSpec): Record<string, unknown> {
  switch (spec.name) {
    case 'claude-code':
      return {
        ok: Boolean(process.env.ANTHROPIC_API_KEY),
        present: ['ANTHROPIC_API_KEY'].filter((k) => Boolean(process.env[k])),
        hints: spec.authHints ?? [],
      };
    case 'codex':
      return {
        ok: Boolean(process.env.OPENAI_API_KEY),
        present: ['OPENAI_API_KEY'].filter((k) => Boolean(process.env[k])),
        hints: spec.authHints ?? [],
      };
    case 'hermes': {
      const envFile = join(homedir(), '.hermes', '.env');
      return {
        ok: existsSync(envFile) || Boolean(process.env.HERMES_API_KEY || process.env.API_SERVER_KEY),
        present: [
          ...['HERMES_API_KEY', 'API_SERVER_KEY'].filter((k) => Boolean(process.env[k])),
          ...(existsSync(envFile) ? [envFile] : []),
        ],
        hints: spec.authHints ?? [],
      };
    }
    case 'openclaw': {
      const cfgFile = join(homedir(), '.openclaw', 'openclaw.json');
      return {
        ok: existsSync(cfgFile) || Boolean(process.env.OPENCLAW_API_KEY),
        present: [
          ...['OPENCLAW_API_KEY'].filter((k) => Boolean(process.env[k])),
          ...(existsSync(cfgFile) ? [cfgFile] : []),
        ],
        hints: spec.authHints ?? [],
      };
    }
    default:
      return { ok: true, present: [], hints: spec.authHints ?? [] };
  }
}

function inspectHook(spec: AdapterInstallSpec): Record<string, unknown> & { markerPresent: boolean } {
  const target = spec.hookTarget;
  if (!target) {
    return { supported: false, markerPresent: false };
  }

  if (spec.name === 'openclaw') {
    const jsonPath = join(homedir(), '.openclaw', 'hooks.json');
    const markerPath = join(target.path, 'prismer.json');
    const jsonMarkerPresent = existsSync(jsonPath) && fileContainsPrismerMarker(jsonPath);
    const dirMarkerPresent = existsSync(markerPath) && fileContainsPrismerMarker(markerPath);
    return {
      supported: true,
      kind: 'json-file-or-directory',
      path: target.path,
      jsonPath,
      exists: existsSync(target.path) || existsSync(jsonPath),
      markerPath,
      markerPresent: jsonMarkerPresent || dirMarkerPresent,
    };
  }

  if (target.kind === 'directory') {
    const markerPath = join(target.path, 'prismer.json');
    return {
      supported: true,
      kind: target.kind,
      path: target.path,
      exists: existsSync(target.path),
      markerPath,
      markerPresent: existsSync(markerPath) && fileContainsPrismerMarker(markerPath),
    };
  }

  const exists = existsSync(target.path);
  if (!exists) {
    return {
      supported: true,
      kind: target.kind,
      path: target.path,
      exists,
      markerPresent: false,
    };
  }

  return {
    supported: true,
    kind: target.kind,
    path: target.path,
    exists,
    markerPresent: fileContainsPrismerMarker(target.path),
  };
}

function plannedHookWrite(spec: AdapterInstallSpec): { kind: 'json-file' | 'directory'; path: string } {
  if (!spec.hookTarget) {
    throw new Error(`No hook target for ${spec.name}`);
  }
  return { kind: spec.hookTarget.kind, path: spec.hookTarget.path };
}

function prismerHookMarker(spec: AdapterInstallSpec): Record<string, unknown> {
  return {
    id: 'prismer-daemon-runtime',
    marker: 'prismer-daemon-runtime',
    adapter: spec.name,
    managed_by: '@prismer/runtime',
    command: 'prismer daemon hook',
    installed_at: new Date().toISOString(),
  };
}

function mergeHookJson(path: string, spec: AdapterInstallSpec): Record<string, unknown> {
  const marker = prismerHookMarker(spec);
  if (!existsSync(path)) {
    return {
      prismer: marker,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot parse ${path} as JSON: ${(err as Error).message}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Cannot merge ${path}: expected a JSON object`);
  }

  const next = { ...parsed };
  next.prismer = marker;
  if (Array.isArray(next.hooks)) {
    const hooks = [...next.hooks];
    const existingIndex = hooks.findIndex(
      (h) => isRecord(h) && (h.marker === 'prismer-daemon-runtime' || h.id === 'prismer-daemon-runtime'),
    );
    if (existingIndex >= 0) {
      hooks[existingIndex] = { ...(isRecord(hooks[existingIndex]) ? hooks[existingIndex] : {}), ...marker };
    } else {
      hooks.push(marker);
    }
    next.hooks = hooks;
  }
  return next;
}

function backupIfExists(path: string): string | null {
  if (!existsSync(path)) return null;
  const suffix = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${path}.bak.${suffix}`;
  const stat = statSync(path);
  if (stat.isDirectory()) return null;
  copyFileSync(path, backup);
  return backup;
}

function fileContainsPrismerMarker(path: string): boolean {
  try {
    return readFileSync(path, 'utf8').includes('prismer-daemon-runtime');
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readAdapterConfig(): Record<string, Record<string, unknown>> {
  const paths = resolvePaths();
  if (!configExists(paths)) return {};
  try {
    const cfg = loadConfig(paths);
    return cfg.adapters ?? {};
  } catch {
    return {};
  }
}

function recordInstallInConfig(spec: AdapterInstallSpec, binPath: string, version: string): void {
  const paths = resolvePaths();
  if (!configExists(paths)) {
    process.stderr.write(
      `! No config.toml at ${paths.configFile} — run \`prismer setup\` first. ` +
        `Adapter installed but not recorded in config.\n`,
    );
    return;
  }
  let cfg: Config;
  try {
    cfg = loadConfig(paths);
  } catch (err) {
    process.stderr.write(`! Failed to load config (${(err as Error).message}); skipping adapter record.\n`);
    return;
  }
  const adapters = cfg.adapters ?? {};
  adapters[spec.name] = {
    package_manager: spec.manager,
    package_name: spec.package,
    binary: binPath,
    version,
    installed_at: new Date().toISOString(),
  };
  saveConfig({ ...cfg, adapters }, paths);
}

function clearInstallInConfig(name: string): void {
  const paths = resolvePaths();
  if (!configExists(paths)) return;
  let cfg: Config;
  try {
    cfg = loadConfig(paths);
  } catch {
    return;
  }
  const adapters = cfg.adapters ?? {};
  if (!(name in adapters)) return;
  delete adapters[name];
  saveConfig({ ...cfg, adapters }, paths);
}
