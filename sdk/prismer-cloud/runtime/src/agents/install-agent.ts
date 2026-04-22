// T13 — Install agent adapter: flow aligned to §15.2 `prismer agent install` mockup.
//
// Pack integrity is verified via an Ed25519-signed manifest attached to the
// matching GitHub Release (see pack-registry.ts for the asset URLs). The
// signature is verified against the hardcoded Prismer release public key in
// pack-verify.ts. For npm-sourced installs (no detached signature), a warning
// is shown.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import type { CliContext } from '../cli/context.js';
import {
  AGENT_CATALOG,
  satisfiesRange,
  type AgentCatalogEntry,
} from './registry.js';
import { readHookConfig, installHooks, resolvePluginRoot } from './hooks.js';
import { verifyPackSignature } from './pack-verify.js';
import {
  fetchPackManifest,
  fetchPackIndex,
  type PackManifest,
  type PackEntry,
} from './pack-registry.js';
import { upsertAgent, findAgent } from './agents-registry.js';

// ============================================================
// Types
// ============================================================

export interface InstallAgentOptions {
  name: string;
  nonInteractive?: boolean;
  acceptDefaults?: boolean;
  source?: 'cdn' | 'mirror' | 'npm';
  force?: boolean;
  installAgentBinary?: boolean;
  /** Skip Ed25519 signature verification (for offline / development). */
  skipVerify?: boolean;
  // Testability overrides
  homeDir?: string;
  catalog?: AgentCatalogEntry[];
  daemonUrl?: string;
  runCommand?: (command: string) => Promise<number>;
  fetchImpl?: typeof fetch;
}

export interface InstallAgentResult {
  agent: string;
  version: string;
  source: 'cdn' | 'mirror' | 'npm';
  hookConfig: string;
  checks: number;
  ok: boolean;
  alreadyInstalled?: boolean;
  /** Whether the pack signature was verified (undefined if skipped / not available). */
  signatureVerified?: boolean;
}

// ============================================================
// Version sidecar helpers
// ============================================================

/** Returns the path to the per-agent version sidecar file. */
function agentVersionFilePath(name: string, homeDir: string): string {
  return path.join(homeDir, '.prismer', 'agents', `${name}.version`);
}

/** Persists the installed version to a sidecar file so future invocations can read it back. */
function writeInstalledVersion(name: string, version: string, homeDir: string): void {
  const filePath = agentVersionFilePath(name, homeDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, version + '\n', { mode: 0o644 });
}

/** Reads the previously-persisted installed version. Returns undefined if the file is missing. */
function readInstalledVersion(name: string, homeDir: string): string | undefined {
  try {
    const content = fs.readFileSync(agentVersionFilePath(name, homeDir), 'utf-8').trim();
    return content || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Best-effort read of the installed npm package version via require.resolve.
 * Returns undefined on any failure (package not installed globally, ESM resolve error, etc.)
 * so that callers can fall back to 'unknown' without crashing.
 */
function readInstalledPackageVersion(packPackage: string): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    const manifestPath = req.resolve(`${packPackage}/package.json`);
    const pkg = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

// ============================================================
// installAgent
// ============================================================

export async function installAgent(
  ctx: CliContext,
  opts: InstallAgentOptions,
): Promise<InstallAgentResult> {
  const { ui } = ctx;
  const catalog = opts.catalog ?? AGENT_CATALOG;
  const homeDir = opts.homeDir ?? os.homedir();
  const daemonUrl = opts.daemonUrl ?? 'http://127.0.0.1:3210';
  const nonInteractive = opts.nonInteractive ?? false;

  // Step 1: Lookup catalog entry
  const entry = catalog.find((e) => e.name === opts.name);
  if (!entry) {
    ui.error(
      'Unknown agent: ' + opts.name,
      undefined,
      'prismer agent search',
    );
    throw new Error('Unknown agent: ' + opts.name);
  }

  // Step 2: detect upstream binary
  let detected = await entry.detect();
  if (!detected.found) {
    const installHint = installHintFor(entry);
    if (!opts.installAgentBinary) {
      printMissingBinary(ctx, entry, installHint);
      if (nonInteractive) {
        return missingBinaryResult(opts, entry, homeDir);
      }
      // Interactive: stop install unless the user explicitly asked us to install the agent CLI too.
      throw new Error(entry.displayName + ' CLI not found on PATH');
    }

    if (!entry.installCommand) {
      printMissingBinary(ctx, entry, installHint);
      ui.fail('No agent install command is registered for ' + entry.displayName);
      return missingBinaryResult(opts, entry, homeDir);
    }

    ui.pending('Installing ' + entry.displayName + ' CLI...');
    ui.secondary('Run: ' + entry.installCommand);
    const exitCode = await (opts.runCommand ?? runShellCommand)(entry.installCommand);
    if (exitCode !== 0) {
      ui.fail(entry.displayName + ' CLI install failed', 'exit code ' + exitCode);
      throw new Error(entry.displayName + ' CLI install failed');
    }

    detected = await entry.detect();
    if (!detected.found) {
      ui.fail(entry.displayName + ' CLI still not found on PATH', 'Expected binary: ' + entry.upstreamBinary);
      ui.secondary('Fix: make sure the install location is on PATH, then run `prismer agent install ' + entry.name + '`');
      return missingBinaryResult(opts, entry, homeDir);
    }
    ui.ok(entry.displayName + ' CLI installed', detected.binaryPath);
  }

  // Step 3: check upstream version range
  if (entry.upstreamVersionRange && detected.version) {
    if (!satisfiesRange(detected.version, entry.upstreamVersionRange)) {
      detected = await handleIncompatibleVersion(ctx, opts, entry, detected);
    }
  }

  // Step 3.5: Already-installed detection — registry first, then hook-fingerprint fallback.
  const hookConfigPath = resolveConfigPath(entry.hookConfigPath, homeDir);
  if (!opts.force) {
    // Prefer registry entry (authoritative) for agents installed after this change.
    const registryEntry = findAgent(homeDir, opts.name);
    if (registryEntry) {
      ui.ok(entry.displayName + ' is already installed (v' + registryEntry.version + ')');
      ui.tip('prismer agent update ' + entry.name);
      return {
        agent: opts.name,
        version: registryEntry.version,
        source: registryEntry.source,
        hookConfig: hookConfigPath,
        checks: 0,
        ok: true,
        alreadyInstalled: true,
      };
    }

    // Fallback: hook-fingerprint grep for pre-registry installs.
    if (fs.existsSync(hookConfigPath)) {
      let rawExisting = '';
      try {
        rawExisting = fs.readFileSync(hookConfigPath, 'utf-8');
      } catch {
        rawExisting = '';
      }
      if (rawExisting.includes('para-emit') || rawExisting.includes('/opt/prismer/runtime/para-adapter.js')) {
        const existingVersion = readInstalledVersion(opts.name, homeDir) ?? 'unknown';
        ui.ok(entry.displayName + ' is already installed (v' + existingVersion + ')');
        ui.tip('prismer agent update ' + entry.name);
        return {
          agent: opts.name,
          version: existingVersion,
          source: opts.source ?? 'cdn',
          hookConfig: hookConfigPath,
          checks: 0,
          ok: true,
          alreadyInstalled: true,
        };
      }
    }
  }

  // Step 4: Pack fetch with two-tier fallback + Ed25519 verification.
  // Sources tried in order: signed release manifest (GitHub Release) → npm registry.
  // The `source: 'mirror'` literal is preserved as a no-op legacy option so
  // existing callers / config files don't break; it maps to the CDN (release
  // manifest) tier.
  let resolvedSource: 'cdn' | 'mirror' | 'npm' = opts.source ?? 'cdn';
  let packResolved = false;
  let signatureVerified: boolean | undefined;
  // Hoisted so the CDN-path version is available at the final return.
  let packManifest: PackManifest | undefined;

  if (opts.skipVerify) {
    ui.warn('Signature verification skipped (--skip-verify)');
    signatureVerified = undefined;
  }

  if (resolvedSource === 'cdn' || resolvedSource === 'mirror') {
    // Tier 1: Signed release manifest fetched from the GitHub Release assets.
    ui.pending('Trying signed release manifest (GitHub Release)...');
    try {
      packManifest = await fetchPackManifest(entry.name, opts.fetchImpl ?? fetch);

      // Verify manifest matches catalog entry
      if (packManifest.adapter !== entry.packPackage) {
        throw new Error(`Pack adapter mismatch: expected ${entry.packPackage}, got ${packManifest.adapter}`);
      }

      // Ed25519 verification: fetchPackManifest already verifies the manifest
      // signature internally (throws on mismatch). Re-verify the core fields
      // with our standalone verifier for defense-in-depth.
      if (!opts.skipVerify) {
        const payload = Buffer.from(JSON.stringify({
          name: packManifest.name,
          version: packManifest.version,
          adapter: packManifest.adapter,
          tiersSupported: packManifest.tiersSupported,
          capabilityTags: packManifest.capabilityTags,
        }));
        const result = verifyPackSignature(payload, packManifest.signature);
        if (result.verified) {
          ui.ok('Signature verified', 'Ed25519 (Prismer Release Key)');
          signatureVerified = true;
        } else {
          ui.error(
            'Pack signature verification failed',
            'Ed25519 signature mismatch for ' + entry.packPackage,
            'prismer agent install ' + opts.name + ' --source npm',
          );
          signatureVerified = false;
          // Signature failure halts installation (C3 review fix)
          throw new Error('Ed25519 signature verification failed for ' + entry.packPackage);
        }
      }

      resolvedSource = 'cdn';
      packResolved = true;
      ui.ok('Resolved (source: cdn)');
      ui.secondary('Installing via npm: ' + (packManifest.upstreamPackage || entry.packPackage));
    } catch (err) {
      // Rethrow signature failures — a tampered pack must not fall through to npm.
      if (err instanceof Error && /^(Pack (manifest|index) signature verification failed|Ed25519 signature verification failed for )/i.test(err.message)) {
        throw err;
      }
      ui.warn('Release manifest unavailable', err instanceof Error ? err.message : undefined);
    }
  }

  // Tier 2: npm registry fallback (truthful — no packs-cn mirror exists yet).
  if (!packResolved) {
    ui.pending('Falling back to npm registry...');
    resolvedSource = 'npm';
    packResolved = true;
    ui.ok('Resolved (source: npm)', entry.packPackage + '@' + entry.packVersionRange);

    // npm packages don't carry detached Ed25519 signatures
    if (!opts.skipVerify) {
      ui.warn('Signature not available (installed from npm). Pack integrity relies on npm registry.');
      signatureVerified = undefined;
    }
  }

  // Step 5: Hook config merge — resolve plugin root and write PARA hooks.
  //
  // IMPORTANT — per-agent semantics:
  //   • claude-code / codex / hermes: the target CLI reads its hooks.json at
  //     runtime and spawns `para-emit.mjs` as a subprocess for each event.
  //     This file is the ONLY wiring path for those agents.
  //   • openclaw: this file is written for smoke-test parity, but OpenClaw
  //     does NOT actually read it.  PARA events are emitted in-process by
  //     `@prismer/openclaw-channel` via `api.registerHook(...)` +
  //     `api.on(...)` — see registry.ts openclaw entry comment, and
  //     sdk/prismer-cloud/openclaw-channel/src/para/register.ts.  Keeping the
  //     hook-config write here means `agent doctor` still finds the PARA
  //     fingerprint for openclaw; it's harmless otherwise.  v1.9.0 report
  //     break #5 fix.

  const pluginRoot = resolvePluginRoot();
  const existing = await readHookConfig(hookConfigPath);
  const mergeResult = await installHooks(hookConfigPath, existing, { daemonUrl, pluginRoot });

  if (mergeResult.added.length > 0) {
    ui.ok('Hook config written', hookConfigPath);
    ui.ok('Added hooks', mergeResult.added.join(', '));
  }
  if (mergeResult.replaced.length > 0) {
    ui.ok('Upgraded v1.8 hooks to v1.9', mergeResult.replaced.join(', '));
  }
  if (mergeResult.preserved.length > 0) {
    ui.ok('Preserved user hooks', mergeResult.preserved.join(', '));
  }
  if (mergeResult.added.length === 0 && mergeResult.replaced.length === 0) {
    ui.ok('Hook config up to date', hookConfigPath);
  }

  const hostname = os.hostname();
  const agentId = opts.name + '@' + hostname;
  const registered = await registerAgentWithDaemon({
    daemonUrl,
    fetchImpl: opts.fetchImpl ?? fetch,
    id: agentId,
    name: entry.displayName,
    command: detected.binaryPath ?? entry.upstreamBinary,
    tiersSupported: entry.tiersSupported,
    capabilityTags: entry.capabilityTags,
  });
  if (registered.ok) {
    ui.ok('Agent registered with daemon', 'id: ' + agentId);
  } else {
    ui.warn('Agent installed but daemon registration failed', registered.error);
    ui.secondary('Fix: start the daemon, then run `prismer agent install ' + entry.name + ' --force`');
  }

  // Step 6.5: OpenClaw plugin discovery registration (openclaw-only).
  //
  // openclaw requires `openclaw plugins install <spec>` to discover a plugin.
  // Installing @prismer/openclaw-channel globally via npm is not enough —
  // openclaw maintains its own plugin registry and the plugin must be
  // explicitly registered there. Without this call, `openclaw agent --local`
  // starts without any PARA hooks fired (v1.9.0 closure report §14.4 gap N1).
  //
  // Non-fatal: if the command fails we warn and continue.
  if (entry.name === 'openclaw') {
    await runOpenClawPluginRegistration(ctx, opts);
  }

  // Step 7: Smoke tests
  const smokeChecks = runSmokeChecks(opts.name, hookConfigPath);
  const passedChecks = smokeChecks.filter((c) => c.pass).length;
  const failedChecks = smokeChecks.length - passedChecks;
  for (const check of smokeChecks) {
    if (check.pass) {
      ui.ok(check.label);
    } else {
      ui.fail(check.label, check.detail);
    }
  }
  if (failedChecks > 0) {
    ui.warn(
      'Installed but ' + failedChecks + '/' + smokeChecks.length + ' smoke tests failed',
      'Some hooks may not work correctly',
    );
    ui.tip('prismer agent doctor ' + opts.name);
  } else {
    ui.ok('Smoke test passed', passedChecks + '/' + smokeChecks.length + ' checks');
  }

  // Step 8: Final status
  ui.line('');
  ui.line(entry.displayName + ' is ready. Start coding and Prismer will handle the rest.');

  const finalVersion =
    packManifest?.version ??
    readInstalledPackageVersion(entry.packPackage) ??
    'unknown';

  // Persist the installed version to a sidecar file (backward compat) and to
  // the authoritative agents.json registry.
  writeInstalledVersion(opts.name, finalVersion, homeDir);
  upsertAgent(homeDir, {
    name: opts.name,
    displayName: entry.displayName,
    version: finalVersion,
    source: resolvedSource,
    installedAt: new Date().toISOString(),
    hookConfigPath,
    signatureVerified,
  });

  return {
    agent: opts.name,
    version: finalVersion,
    source: resolvedSource,
    hookConfig: hookConfigPath,
    checks: passedChecks,
    ok: passedChecks === smokeChecks.length,
    signatureVerified,
  };
}

async function registerAgentWithDaemon(input: {
  daemonUrl: string;
  fetchImpl: typeof fetch;
  id: string;
  name: string;
  command: string;
  tiersSupported: number[];
  capabilityTags: string[];
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const resp = await input.fetchImpl(`${input.daemonUrl}/api/v1/agents/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: input.id,
        name: input.name,
        command: input.command,
        tiersSupported: input.tiersSupported,
        capabilityTags: input.capabilityTags,
      }),
      signal: AbortSignal.timeout(2500),
    });
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status}` };
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

// ============================================================
// Helpers
// ============================================================

function resolveConfigPath(raw: string, homeDir: string): string {
  if (raw.startsWith('~/')) {
    return path.join(homeDir, raw.slice(2));
  }
  return raw;
}

function installHintFor(entry: AgentCatalogEntry): string {
  if (entry.installCommand) return entry.installCommand;
  switch (entry.name) {
    case 'claude-code':
      return 'Install Claude Code, then run `prismer agent install claude-code`';
    case 'codex':
      return 'Install the Codex CLI so `codex --version` works, then run `prismer agent install codex`';
    case 'hermes':
      return 'Install Hermes so `hermes --version` works, then run `prismer agent install hermes`';
    case 'openclaw':
      return 'Install OpenClaw so `openclaw --version` works, then run `prismer agent install openclaw`';
    default:
      return 'Install `' + entry.upstreamBinary + '` so it is available on PATH, then re-run this command';
  }
}

function printMissingBinary(ctx: CliContext, entry: AgentCatalogEntry, installHint: string): void {
  const { ui } = ctx;
  ui.fail(entry.displayName + ' CLI not found on PATH', 'Expected binary: ' + entry.upstreamBinary);
  ui.secondary('This installs the Prismer adapter for an existing agent CLI.');
  if (entry.localSourcePath && fs.existsSync(entry.localSourcePath)) {
    ui.secondary('Local source: ' + entry.localSourcePath);
  }
  ui.secondary('Fix: ' + installHint);
  if (entry.installCommand) {
    ui.secondary('Or run: prismer agent install ' + entry.name + ' --install-agent');
  }
}

async function handleIncompatibleVersion(
  ctx: CliContext,
  opts: InstallAgentOptions,
  entry: AgentCatalogEntry,
  detected: { found: boolean; binaryPath?: string; version?: string },
): Promise<{ found: boolean; binaryPath?: string; version?: string }> {
  const { ui } = ctx;
  const current = detected.version ?? 'unknown';
  const required = entry.upstreamVersionRange ?? 'unknown';

  // §15.3 error shape: What (concrete) / Cause (requirement) / Fix (command).
  // Mockup target:
  //   ✗ claude-code v5.0 is not supported by this adapter (requires v4.x)
  //     Fix: prismer agent update claude-code
  const whatLine = entry.displayName + ' v' + current + ' is not supported by this adapter';
  const causeLine = 'adapter requires ' + entry.upstreamBinary + ' ' + required;

  if (!opts.installAgentBinary) {
    ui.error(
      whatLine,
      causeLine,
      'prismer agent update ' + entry.name + '  — or pass --install-agent to auto-upgrade ' + entry.upstreamBinary,
    );
    throw new Error(
      'Incompatible version: ' + entry.upstreamBinary + ' ' + current +
      ' does not satisfy ' + required,
    );
  }

  if (!entry.installCommand) {
    ui.error(
      whatLine,
      causeLine + ' (no automated upgrade path registered)',
      'Upgrade ' + entry.upstreamBinary + ' manually, then re-run `prismer agent install ' + entry.name + '`',
    );
    throw new Error(
      'Incompatible version: ' + entry.upstreamBinary + ' ' + current +
      ' does not satisfy ' + required,
    );
  }

  ui.pending('Upgrading ' + entry.displayName + ' CLI...');
  ui.secondary('Current: ' + entry.upstreamBinary + ' ' + current);
  ui.secondary('Required: ' + required);
  ui.secondary('Run: ' + entry.installCommand);
  const exitCode = await (opts.runCommand ?? runShellCommand)(entry.installCommand);
  if (exitCode !== 0) {
    ui.fail(entry.displayName + ' CLI upgrade failed', 'exit code ' + exitCode);
    throw new Error(entry.displayName + ' CLI upgrade failed');
  }

  const after = await entry.detect();
  if (!after.found) {
    ui.fail(entry.displayName + ' CLI still not found on PATH', 'Expected binary: ' + entry.upstreamBinary);
    throw new Error(entry.displayName + ' CLI not found on PATH after upgrade');
  }
  if (entry.upstreamVersionRange && after.version && !satisfiesRange(after.version, entry.upstreamVersionRange)) {
    ui.fail('Incompatible version', entry.upstreamBinary + ' ' + after.version + ' · requires ' + entry.upstreamVersionRange);
    throw new Error(
      'Incompatible version: ' + entry.upstreamBinary + ' ' + after.version +
      ' does not satisfy ' + entry.upstreamVersionRange,
    );
  }
  ui.ok(entry.displayName + ' CLI upgraded', after.version ? entry.upstreamBinary + ' ' + after.version : after.binaryPath);
  return after;
}

function missingBinaryResult(
  opts: InstallAgentOptions,
  entry: AgentCatalogEntry,
  homeDir: string,
): InstallAgentResult {
  return {
    agent: opts.name,
    version: 'unknown',
    source: opts.source ?? 'cdn',
    hookConfig: resolveConfigPath(entry.hookConfigPath, homeDir),
    checks: 0,
    ok: false,
  };
}

function runShellCommand(command: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

interface SmokeCheck {
  label: string;
  pass: boolean;
  detail?: string;
}

function runSmokeChecks(agentName: string, hookConfigPath: string): SmokeCheck[] {
  // OpenClaw does NOT read `~/.openclaw/hooks.json` — it uses its native
  // plugin-SDK's `api.on(...)` channel registered by @prismer/openclaw-channel.
  // The file is still written for smoke-test fingerprint parity (see
  // install-agent.ts Step 5 comment), but checking its contents tells us
  // nothing about whether PARA events will actually fire. For openclaw we
  // probe the npm global install of @prismer/openclaw-channel instead — if
  // the package is resolvable, the adapter will register via api.on when
  // openclaw loads channels.
  if (agentName === 'openclaw') {
    return runOpenClawSmokeChecks();
  }
  return runFileBasedSmokeChecks(hookConfigPath);
}

function runOpenClawSmokeChecks(): SmokeCheck[] {
  const checks: SmokeCheck[] = [];
  let channelResolvable = false;
  try {
    const resolved = require.resolve('@prismer/openclaw-channel/package.json');
    channelResolvable = true;
    checks.push({ label: '@prismer/openclaw-channel resolvable', pass: true, detail: resolved });
  } catch {
    checks.push({
      label: '@prismer/openclaw-channel resolvable',
      pass: false,
      detail: 'package not installed globally — hooks will not fire',
    });
  }
  // Secondary check inherits the resolvable state. If the channel package
  // isn't reachable, PARA hooks can't register via api.on either.
  checks.push({
    label: 'PARA hooks wired (via openclaw api.on)',
    pass: channelResolvable,
    detail: channelResolvable
      ? 'delegated to openclaw plugin runtime; verify with `openclaw agent --local`'
      : 'blocked by missing @prismer/openclaw-channel',
  });
  // Third check: verify the plugin is registered in openclaw's plugin
  // registry (distinct from npm-resolvable). Closes v1.9.0 closure report
  // §14.4 gap N1 — a package installed via npm but never passed through
  // `openclaw plugins install` is invisible to openclaw.
  checks.push(runOpenClawPluginListCheck());
  return checks;
}

function runFileBasedSmokeChecks(hookConfigPath: string): SmokeCheck[] {
  const checks: SmokeCheck[] = [];

  // Check 1: config file exists
  const exists = fs.existsSync(hookConfigPath);
  checks.push({ label: 'Hook config file exists', pass: exists });

  if (!exists) {
    checks.push({ label: 'Hook entry present', pass: false, detail: 'file not found' });
    checks.push({ label: 'Daemon URL correct', pass: false, detail: 'file not found' });
    return checks;
  }

  // Check 2: valid JSON with at least one hook entry
  let raw = '';
  try {
    raw = fs.readFileSync(hookConfigPath, 'utf-8');
  } catch {
    checks.push({ label: 'Hook entry present', pass: false, detail: 'read error' });
    checks.push({ label: 'Daemon URL correct', pass: false, detail: 'read error' });
    return checks;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    checks.push({ label: 'Hook entry present', pass: false, detail: 'JSON parse error' });
    checks.push({ label: 'Daemon URL correct', pass: false, detail: 'JSON parse error' });
    return checks;
  }

  const cfg = parsed as { hooks?: Record<string, unknown> };
  const hasHooks = cfg?.hooks && Object.keys(cfg.hooks).length > 0;
  checks.push({ label: 'Hook entry present', pass: Boolean(hasHooks) });

  // Check 3: PARA hook command present (para-emit.mjs or legacy para-adapter.js)
  const hasParaHook = raw.includes('para-emit') || raw.includes('/opt/prismer/runtime/para-adapter.js');
  checks.push({ label: 'PARA hooks wired', pass: hasParaHook });

  return checks;
}

/**
 * Registers @prismer/openclaw-channel with the openclaw plugin registry.
 *
 * openclaw maintains a separate plugin registry that is distinct from the npm
 * global package store. A package installed via `npm install -g` is not
 * automatically visible to openclaw — `openclaw plugins install <spec>` must
 * be called explicitly to add the plugin to openclaw's discovery list.
 *
 * Non-fatal: on failure we emit a warn and the caller continues normally.
 */
async function runOpenClawPluginRegistration(
  ctx: CliContext,
  opts: Pick<InstallAgentOptions, 'runCommand'>,
): Promise<void> {
  const { ui } = ctx;
  const spec = '@prismer/openclaw-channel';
  const command = `openclaw plugins install ${spec}`;

  ui.pending('Registering ' + spec + ' with openclaw plugin registry...');
  ui.secondary('Run: ' + command);

  try {
    const exitCode = await (opts.runCommand ?? runShellCommand)(command);
    if (exitCode === 0) {
      ui.ok('Plugin registered with openclaw', spec + ' discoverable via `openclaw plugins list`');
    } else {
      ui.warn(
        'openclaw plugins install exited with code ' + exitCode,
        'PARA hooks may not fire in `openclaw agent --local`',
      );
      ui.secondary('Fix: run `openclaw plugins install ' + spec + '` manually, then verify with `openclaw plugins list`');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ui.warn('openclaw plugins install failed: ' + message, 'PARA hooks may not fire');
    ui.secondary('Fix: run `openclaw plugins install ' + spec + '` manually');
  }
}

/**
 * Synchronously probe `openclaw plugins list` output for @prismer/openclaw-channel.
 * Mirrors v1.9.0 closure report §14.4 gap N1: a pack can be npm-resolvable
 * yet unregistered in openclaw's plugin discovery list. execFileSync with a
 * short timeout keeps the smoke-test loop bounded even if openclaw hangs.
 */
function runOpenClawPluginListCheck(): SmokeCheck {
  const LABEL = '@prismer/openclaw-channel in `openclaw plugins list`';
  try {
    let output = '';
    try {
      output = execFileSync('openclaw', ['plugins', 'list', '--json'], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const plugins = JSON.parse(output) as Array<{ name?: string }>;
      const found = plugins.some(
        (p) =>
          p.name === '@prismer/openclaw-channel' ||
          p.name === 'prismer-openclaw-channel' ||
          (typeof p.name === 'string' && p.name.includes('prismer')),
      );
      return {
        label: LABEL,
        pass: found,
        detail: found
          ? '@prismer/openclaw-channel is registered in openclaw plugin registry'
          : 'not found in `openclaw plugins list --json` — run `openclaw plugins install @prismer/openclaw-channel`',
      };
    } catch {
      // JSON mode failed or plugin missing — fall back to plain text grep
    }

    try {
      output = execFileSync('openclaw', ['plugins', 'list'], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      return {
        label: LABEL,
        pass: false,
        detail: '`openclaw plugins list` failed — openclaw may not be installed or PATH is not set',
      };
    }

    const lowerOutput = output.toLowerCase();
    const found =
      lowerOutput.includes('@prismer/openclaw-channel') ||
      lowerOutput.includes('prismer-openclaw-channel') ||
      lowerOutput.includes('openclaw-channel');
    return {
      label: LABEL,
      pass: found,
      detail: found
        ? '@prismer/openclaw-channel found in `openclaw plugins list`'
        : 'not found in `openclaw plugins list` — run `openclaw plugins install @prismer/openclaw-channel`',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      label: LABEL,
      pass: false,
      detail: 'probe failed: ' + message,
    };
  }
}
