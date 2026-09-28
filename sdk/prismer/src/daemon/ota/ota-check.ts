// ota-check.ts — boot-time runtime-bundle OTA state machine (product204/08
// §2.3 + §2.5, M9-β).
//
//   检查 → 下载 → 验签(sha256/sha512 + ed25519) → 解包 → 切换指针 → [exec]
//        ↘ 任一步失败 → incident 回传 → 落回 current/previous/builtin(镜像永固)
//   上次 boot 未确认(marker 残留) → 计一次失败 → 回退上一版(回滚位)
//        连续 2 次 → 拉黑该版本 + 删目录 → 停留 previous/builtin
//
// The resolver runs INSIDE the image's built-in runtime (entrypoint invokes
// `prismer ota resolve --exec-path` before exec'ing the daemon), so the image
// is always the working floor: any failure here degrades to "boot the builtin
// runtime", never to a bricked pod.
//
// Incident 回传 walks the EXISTING desktop release-health sink
// (`POST /api/desktop/update/report`, migration 499 vocabulary:
// downloaded/verified/applied/boot_ok/verify_failed/boot_failed/rolled_back/
// blacklisted) with component='daemon'. 成功升级回传 `applied`(+确认后
// `boot_ok`) —— 熔断统计的分母.
//
// (α-wave, verified cross-wave) the desktop report route now ALSO admits the
// K8s `container:<podName>` id shape and derives `reportedVia` from the id
// form; the canonical daemon sink `POST /api/runtime/update/report` writes the
// same table with the same breaker arithmetic, so this reporter can cut over
// URL-only whenever convenient.

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolvePaths } from '../../config.js';
import { verifyBundleSignature } from './pubkey.js';
import { evaluateRuntimeUpdateDirection, type RuntimeUpdateDecision } from '../runtime-update-direction.js';
import {
  armBootMarker,
  bundleDir,
  bundleRoot,
  cleanupUnreferenced,
  clearBootFailures,
  clearBootMarker,
  clearPointer,
  isBlacklisted,
  isValidBundleDir,
  linkBuiltinNativeDeps,
  readBootMarker,
  readPointer,
  readVerifiedRuntimeMetadata,
  recordBootFailure,
  removeBundleDir,
  writeVerifiedRuntimeMetadata,
  writePointer,
} from './bundle-store.js';

// ── types ─────────────────────────────────────────────────────────────────────

/** Normalized manifest offer (08 §2.2 contract: sha256 per M9-β; desktop legacy sha512 also accepted). */
export interface BundleOffer {
  decision: RuntimeUpdateDecision;
  version: string;
  url: string;
  sha256?: string;
  sha512?: string;
  signature: string;
}

export type OtaOutcome =
  | 'downloaded'
  | 'verified'
  | 'applied'
  | 'boot_ok'
  | 'verify_failed'
  | 'boot_failed'
  | 'rolled_back'
  | 'blacklisted'
  | 'other';

export interface OtaDeps {
  /** PRISMER_HOME root (`~/.prismer`). */
  home: string;
  /** Cloud REST base for manifest + incident report. Absent ⇒ offline resolve only. */
  cloudBase?: string;
  daemonId?: string;
  /** Server-minted workspace Runtime API key used by authenticated report sinks. */
  apiKey?: string;
  /** Release channel; default `PRISMER_BUNDLE_CHANNEL` env, then `k8s`. */
  channel?: string;
  /** Full manifest URL override (`PRISMER_BUNDLE_MANIFEST_URL`). */
  manifestUrl?: string;
  /** Public key override (base64 SPKI DER); default `DAEMON_BUNDLE_PUBKEY` env → built-in. */
  pubkeyB64?: string;
  /** Built-in runtime version (for `current=` in the manifest query). */
  builtinVersion?: string;
  fetchImpl?: typeof fetch;
  /** Manifest negotiation timeout per attempt (08: 3s). */
  manifestTimeoutMs?: number;
  /** Bundle download timeout (fat zip — separate, wider allowance; 08 §6.5). */
  downloadTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface BootResolution {
  /** Absolute path of the cli.js to exec, or null when the builtin runtime should run. */
  execPath: string | null;
  dir: string | null;
  version: string;
  source: 'bundle' | 'builtin';
  /** True when this resolve freshly downloaded+applied a new bundle. */
  applied: boolean;
}

const MANIFEST_TIMEOUT_MS = 3_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const REPORT_TIMEOUT_MS = 3_000;
/** Grace window after runner.start() before a bundle boot is confirmed. */
export const BOOT_CONFIRM_DELAY_MS = 10_000;

// ── incident report (fire-and-forget with bounded await) ─────────────────────

function normalizeRuntimeApiKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) return undefined;
  return trimmed;
}

function resolveRuntimeApiKey(deps: OtaDeps): string | undefined {
  return deps.apiKey !== undefined
    ? normalizeRuntimeApiKey(deps.apiKey)
    : normalizeRuntimeApiKey(process.env.PRISMER_API_KEY);
}

function runtimeCloudAuthorization(
  deps: OtaDeps,
  candidate: string | URL,
  allowedPath: (pathname: string) => boolean,
): Record<string, string> | undefined {
  const apiKey = resolveRuntimeApiKey(deps);
  if (!apiKey || !deps.cloudBase) return undefined;
  try {
    const cloud = new URL(deps.cloudBase);
    const url = new URL(candidate);
    if (url.origin !== cloud.origin || !allowedPath(url.pathname)) return undefined;
    return { authorization: `Bearer ${apiKey}` };
  } catch {
    return undefined;
  }
}

async function reportOta(
  deps: OtaDeps,
  outcome: OtaOutcome,
  extra: { daemonVersion?: string; previousVersion?: string; reason?: string },
): Promise<void> {
  if (!deps.cloudBase) return;
  const apiKey = resolveRuntimeApiKey(deps);
  if (!apiKey) {
    deps.log?.('[bundle-ota] report skipped: runtime API key unavailable');
    return;
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  // 2026-07-20 — cut over to the canonical daemon-channel sink (the desktop
  // route rejects the bare-UUID daemonIds the sandbox controller injects, so
  // UUID-id pods' OTA telemetry was silently dropped).
  const url = `${deps.cloudBase.replace(/\/$/, '')}/api/runtime/update/report`;
  const body = {
    component: 'daemon',
    outcome,
    daemonId: deps.daemonId,
    channel: deps.channel ?? process.env.PRISMER_BUNDLE_CHANNEL ?? 'k8s',
    platform: process.platform,
    daemonVersion: extra.daemonVersion,
    previousVersion: extra.previousVersion,
    reason: extra.reason,
  };
  try {
    await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });
  } catch {
    /* telemetry is strictly downstream of updating — never fail OTA over it */
  }
}

/**
 * product204/36 follow-up (2026-07-20) — daemon-side capability-install
 * failures must be cloud-visible. The 2026-07-19 memory-layer regression
 * (hermes MemoryProvider shell missing from the OTA bundle) was only written
 * to stderr; nobody saw it until an agent self-reported. This posts a
 * `capability_install_failed` incident to the canonical daemon release-health
 * sink (`POST /api/runtime/update/report` → im_daemon_incidents), surfaced by
 * the existing admin reader `/api/sandboxes/_admin/runtime-incidents`.
 *
 * Fire-and-forget by design: telemetry must never break profile prepare.
 * cloudBase/daemonId resolve from env/config via bootDepsFromEnvironment.
 */
export function reportCapabilityIncident(detail: string, overrides?: Partial<OtaDeps>): void {
  try {
    const home = overrides?.home ?? resolvePaths().root;
    const deps = bootDepsFromEnvironment(home, overrides);
    if (!deps.cloudBase) return;
    const apiKey = resolveRuntimeApiKey(deps);
    if (!apiKey) {
      deps.log?.('[bundle-ota] capability incident skipped: runtime API key unavailable');
      return;
    }
    const url = `${deps.cloudBase.replace(/\/$/, '')}/api/runtime/update/report`;
    const fetchImpl = deps.fetchImpl ?? fetch;
    void fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        daemonId: deps.daemonId,
        reportedVia: 'daemon',
        outcome: 'capability_install_failed',
        channel: deps.channel ?? 'k8s',
        platform: process.platform,
        daemonVersion: resolveOwnRuntimeVersion() ?? undefined,
        reason: detail.slice(0, 500),
      }),
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    }).catch(() => {});
  } catch {
    /* never throw out of telemetry */
  }
}

// ── manifest negotiation ──────────────────────────────────────────────────────

function normalizeOffer(json: unknown): BundleOffer | null {
  if (!json || typeof json !== 'object') return null;
  const j = json as Record<string, unknown>;
  // Desktop / unified shape: { decision, components: { daemon: {...} } }
  const components = j.components as Record<string, unknown> | undefined;
  const daemonComp = components?.daemon as Record<string, unknown> | undefined;
  if (daemonComp) {
    const decision = typeof j.decision === 'string' ? j.decision : 'ota';
    if (!['ota', 'forced', 'rollback'].includes(decision)) return null;
    return pickOffer(daemonComp, decision === 'rollback' ? 'rollback' : 'ota');
  }
  // Flat 08 §2.2 shape: { version, url, sha256, signature, rollout }
  if (typeof j.version === 'string' && typeof j.url === 'string') {
    if (typeof j.decision === 'string' && j.decision === 'none') return null;
    return pickOffer(j, j.decision === 'rollback' ? 'rollback' : 'ota');
  }
  return null;
}

function pickOffer(c: Record<string, unknown>, decision: RuntimeUpdateDecision): BundleOffer | null {
  const version = typeof c.version === 'string' ? c.version.trim() : '';
  const url = typeof c.url === 'string' ? c.url.trim() : '';
  const signature =
    typeof c.signature === 'string' ? c.signature : typeof c.sig === 'string' ? (c.sig as string) : '';
  const sha256 = typeof c.sha256 === 'string' ? c.sha256 : undefined;
  const sha512 = typeof c.sha512 === 'string' ? c.sha512 : undefined;
  if (!version || !url) return null;
  // Path-traversal hard gate: the version becomes an on-disk dir name.
  if (version.includes('/') || version.includes('..')) return null;
  return { decision, version, url, sha256, sha512, signature };
}

/**
 * Version that can actually execute on this boot. A corrupt/unverified pointer
 * is not allowed to impersonate a newer current runtime and suppress a valid
 * forward OTA; resolution would fall back to builtin in that case anyway.
 */
function effectiveCurrentVersion(deps: OtaDeps): string | undefined {
  const root = bundleRoot(deps.home);
  const current = readPointer(root, 'current');
  if (current && !isBlacklisted(root, current)) {
    const proof = readVerifiedRuntimeMetadata(root, current);
    if (isValidBundleDir(bundleDir(root, current)) && proof?.previous === readPointer(root, 'previous')) {
      return current;
    }
  }
  return deps.builtinVersion;
}

async function fetchManifest(deps: OtaDeps): Promise<BundleOffer | null> {
  if (!deps.cloudBase && !deps.manifestUrl) return null;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeout = deps.manifestTimeoutMs ?? MANIFEST_TIMEOUT_MS;
  const base = deps.cloudBase?.replace(/\/$/, '') ?? '';
  // Candidate order: explicit override → unified runtime endpoint (08 §2.2) →
  // existing desktop endpoint (α-wave transition fallback).
  const candidates = deps.manifestUrl
    ? [deps.manifestUrl]
    : [`${base}/api/runtime/update/manifest`, `${base}/api/desktop/update/manifest`];
  for (const candidate of candidates) {
    const url = new URL(candidate);
    if (!url.searchParams.has('channel')) {
      url.searchParams.set('channel', deps.channel ?? process.env.PRISMER_BUNDLE_CHANNEL ?? 'k8s');
    }
    if (deps.daemonId) url.searchParams.set('daemonId', deps.daemonId);
    const current = effectiveCurrentVersion(deps);
    if (current) {
      url.searchParams.set('current', current);
      url.searchParams.set('daemonVersion', current);
    }
    // The desktop route deletes the daemon component for external hosts.
    url.searchParams.set('daemonHost', 'embedded');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const headers = runtimeCloudAuthorization(
          deps,
          url,
          (pathname) => pathname === '/api/runtime/update/manifest' || pathname === '/api/desktop/update/manifest',
        );
        const res = await fetchImpl(url.toString(), { headers, signal: AbortSignal.timeout(timeout) });
        if (res.status === 404) break; // endpoint absent — try next candidate
        if (!res.ok) continue; // transient — retry once
        const offer = normalizeOffer(await res.json());
        if (offer) return offer;
        return null; // reachable manifest says none/no daemon component
      } catch {
        /* timeout / network — retry, then next candidate */
      }
    }
  }
  return null;
}

// ── download + verify + extract + switch ─────────────────────────────────────

function unzip(zip: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('unzip', ['-o', '-qq', zip, '-d', dest], { stdio: 'ignore' });
    proc.on('error', reject);
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`unzip exited ${code}`))));
  });
}

/**
 * Download → sha (256 and/or 512) → ed25519 over the RAW zip bytes → ONLY THEN
 * unzip → validate entries + version → link native deps → pointer switch
 * (previous = old current — the 回滚位). Returns true on success. Verify-or-die:
 * a bundle that fails any check is never extracted, never executed.
 */
async function downloadVerifyApply(deps: OtaDeps, offer: BundleOffer, root: string): Promise<boolean> {
  const log = deps.log ?? (() => undefined);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const zipPath = join(root, `.download-${offer.version}.zip`);
  const destDir = bundleDir(root, offer.version);
  const stagingDir = join(root, `.staging-${offer.version}-${process.pid}`);
  const replacedDir = join(root, `.replaced-${offer.version}-${process.pid}`);
  try {
    // 1. download.
    const headers = runtimeCloudAuthorization(
      deps,
      offer.url,
      (pathname) => pathname.startsWith('/api/runtime/update/bundle/'),
    );
    const res = await fetchImpl(offer.url, {
      headers,
      signal: AbortSignal.timeout(deps.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) {
      log(`[bundle-ota] ❌ download HTTP ${res.status} for v${offer.version}`);
      await reportOta(deps, 'verify_failed', { daemonVersion: offer.version, reason: `download-http-${res.status}` });
      return false;
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    const verifiedSha256 = createHash('sha256').update(bytes).digest('hex');

    // 2. content hash — the 08 §2.2 M9-β contract is sha256; the desktop legacy
    // manifest carries sha512. Verify every digest the offer declares; at least
    // one MUST be present.
    if (!offer.sha256 && !offer.sha512) {
      log(`[bundle-ota] ❌ offer v${offer.version} carries no content hash — rejecting`);
      await reportOta(deps, 'verify_failed', { daemonVersion: offer.version, reason: 'no-content-hash' });
      return false;
    }
    for (const [algo, expected] of [
      ['sha256', offer.sha256],
      ['sha512', offer.sha512],
    ] as const) {
      if (!expected) continue;
      const digest = algo === 'sha256' ? verifiedSha256 : createHash(algo).update(bytes).digest('hex');
      if (digest.toLowerCase() !== expected.toLowerCase()) {
        log(`[bundle-ota] ❌ ${algo} mismatch for v${offer.version} — rejecting (no extract)`);
        await reportOta(deps, 'verify_failed', { daemonVersion: offer.version, reason: `${algo}-mismatch` });
        return false;
      }
    }

    // 3. ed25519 signature over the raw zip bytes. A missing signature is a
    // rejection, not a skip.
    if (!offer.signature || !verifyBundleSignature(bytes, offer.signature, deps.pubkeyB64)) {
      log(`[bundle-ota] ❌ ed25519 signature invalid for v${offer.version} — rejecting (no extract)`);
      await reportOta(deps, 'verify_failed', { daemonVersion: offer.version, reason: 'signature-invalid' });
      return false;
    }

    // 4. ONLY NOW extract.
    mkdirSync(root, { recursive: true });
    writeFileSync(zipPath, bytes);
    rmSync(stagingDir, { recursive: true, force: true });
    rmSync(replacedDir, { recursive: true, force: true });
    mkdirSync(stagingDir, { recursive: true });
    await unzip(zipPath, stagingDir);

    // 5. validate: required entries + the extracted package.json version must
    // equal the offered version (双版本源 drift 门禁, 08 §6.3).
    if (!isValidBundleDir(stagingDir)) {
      throw new Error('extracted bundle missing dist/cli.js or package.json');
    }
    const pkg = JSON.parse(readFileSync(join(stagingDir, 'package.json'), 'utf8')) as { version?: string };
    if (pkg.version !== offer.version) {
      throw new Error(`bundle package.json version ${pkg.version} ≠ offered ${offer.version}`);
    }

    // 6. borrow native deps from the frozen image layer.
    linkBuiltinNativeDeps(stagingDir, log);

    // 7. pointer switch — old current becomes the rollback slot.
    const oldCurrent = readPointer(root, 'current');
    const oldPrevious = readPointer(root, 'previous');
    if (existsSync(destDir)) renameSync(destDir, replacedDir);
    renameSync(stagingDir, destDir);
    try {
      const nextPrevious = oldCurrent && oldCurrent !== offer.version ? oldCurrent : oldPrevious;
      if (nextPrevious) writePointer(root, 'previous', nextPrevious);
      else clearPointer(root, 'previous');
      writePointer(root, 'current', offer.version);
      writeVerifiedRuntimeMetadata(root, offer.version, {
        version: offer.version,
        current: offer.version,
        previous: nextPrevious,
        sha256: verifiedSha256,
        signatureSha256: createHash('sha256').update(Buffer.from(offer.signature, 'base64')).digest('hex'),
      });
    } catch (error) {
      if (oldCurrent) writePointer(root, 'current', oldCurrent);
      else clearPointer(root, 'current');
      if (oldPrevious) writePointer(root, 'previous', oldPrevious);
      else clearPointer(root, 'previous');
      rmSync(destDir, { recursive: true, force: true });
      if (existsSync(replacedDir)) renameSync(replacedDir, destDir);
      throw error;
    }
    rmSync(replacedDir, { recursive: true, force: true });
    log(`[bundle-ota] applied v${offer.version} (verified ${offer.sha256 ? 'sha256' : ''}${offer.sha256 && offer.sha512 ? '+' : ''}${offer.sha512 ? 'sha512' : ''} + ed25519)${oldCurrent ? `, previous=${oldCurrent}` : ''}`);
    await reportOta(deps, 'applied', {
      daemonVersion: offer.version,
      previousVersion: oldCurrent ?? deps.builtinVersion,
    });
    return true;
  } catch (err) {
    log(`[bundle-ota] ❌ apply v${offer.version} failed: ${(err as Error).message}`);
    rmSync(stagingDir, { recursive: true, force: true });
    if (existsSync(replacedDir) && !existsSync(destDir)) renameSync(replacedDir, destDir);
    await reportOta(deps, 'boot_failed', {
      daemonVersion: offer.version,
      reason: `apply-failed: ${(err as Error).message}`.slice(0, 400),
    });
    return false;
  } finally {
    rmSync(zipPath, { force: true });
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

// ── failure settlement (previous boot never confirmed) ───────────────────────

/**
 * Settle a surviving boot-attempt marker: the last resolve handed out a bundle
 * that never confirmed boot ⇒ count one failure. First strike rolls current
 * back to the previous slot (回滚位); the second strike blacklists the version
 * and removes its dir (镜像永固兜底 — resolution then floors at previous/builtin).
 */
async function settlePreviousBoot(deps: OtaDeps, root: string): Promise<void> {
  const log = deps.log ?? (() => undefined);
  const marker = readBootMarker(root);
  if (!marker) return;
  clearBootMarker(root);
  const { count, blacklisted } = recordBootFailure(root, marker.version);
  log(`[bundle-ota] ❌ previous boot of v${marker.version} never confirmed (strike ${count}/2)`);
  await reportOta(deps, 'boot_failed', { daemonVersion: marker.version, reason: `boot-unconfirmed-strike-${count}` });

  if (readPointer(root, 'current') === marker.version) {
    const previous = readPointer(root, 'previous');
    const proof = previous ? readVerifiedRuntimeMetadata(root, previous) : null;
    if (previous && proof && isValidBundleDir(bundleDir(root, previous))) {
      writeVerifiedRuntimeMetadata(root, previous, {
        version: previous,
        current: previous,
        previous: null,
        sha256: proof.sha256,
        signatureSha256: proof.signatureSha256,
      });
      writePointer(root, 'current', previous);
      clearPointer(root, 'previous');
      log(`[bundle-ota] rolled back current → verified v${previous}`);
    } else {
      clearPointer(root, 'current');
      log('[bundle-ota] rolled back current → builtin (no verified previous slot)');
    }
    await reportOta(deps, 'rolled_back', {
      daemonVersion: marker.version,
      previousVersion: readPointer(root, 'current') ?? deps.builtinVersion,
    });
  }
  if (blacklisted) {
    removeBundleDir(root, marker.version);
    log(`[bundle-ota] v${marker.version} BLACKLISTED after ${count} strikes — dir removed`);
    await reportOta(deps, 'blacklisted', { daemonVersion: marker.version });
  }
}

// ── main boot-time entry ──────────────────────────────────────────────────────

/**
 * The complete boot-time OTA pass. Called by `prismer ota resolve` (which the
 * K8s entrypoint invokes before exec'ing the daemon). Never throws: every
 * failure path degrades to the builtin resolution.
 */
export async function runBootOta(deps: OtaDeps): Promise<BootResolution> {
  const log = deps.log ?? (() => undefined);
  const root = bundleRoot(deps.home);
  let applied = false;

  try {
    // 1. settle an unconfirmed previous boot (failure → rollback → blacklist).
    // product209/09 S2 (WP-E): when sandbox-manager is present, OTA settle
    // is handled by the Rust manager BEFORE this resolver runs. The TS-side
    // settle must NOT run to avoid double-settle (two paths incrementing
    // strike count independently, leading to premature blacklisting).
    if (!process.env.SANDBOX_MANAGER_PRESENT) {
      await settlePreviousBoot(deps, root);
    } else {
      log?.('[bundle-ota] sandbox-manager present — skipping TS settle (manager handles it)');
    }

    // 2. clean unreferenced extractions (blacklisted/orphaned dirs must not
    //    resurrect across in-place container restarts).
    const removed = cleanupUnreferenced(root);
    if (removed.length > 0) log(`[bundle-ota] cleaned unreferenced bundle dirs: ${removed.join(', ')}`);

    // 3. manifest negotiation (3s + retry; offline/none ⇒ keep local state).
    const offer = await fetchManifest(deps);
    if (offer) {
      const currentVersion = effectiveCurrentVersion(deps) ?? '';
      const direction = evaluateRuntimeUpdateDirection({
        currentVersion,
        targetVersion: offer.version,
        decision: offer.decision,
      });
      if (!direction.accepted) {
        log(
          `[bundle-ota] manifest target v${offer.version} refused: ${direction.reason} ` +
            `(decision=${offer.decision}, current=${currentVersion || '(unknown)'})`,
        );
      } else if (isBlacklisted(root, offer.version)) {
        log(`[bundle-ota] manifest offers v${offer.version} but it is blacklisted locally — refusing`);
      } else if (
        readPointer(root, 'current') === offer.version &&
        isValidBundleDir(bundleDir(root, offer.version)) &&
        readVerifiedRuntimeMetadata(root, offer.version)?.previous === readPointer(root, 'previous')
      ) {
        log(`[bundle-ota] already on offered v${offer.version}`);
      } else {
        applied = await downloadVerifyApply(deps, offer, root);
      }
    }
  } catch (err) {
    // Belt-and-braces: nothing above should throw, but the resolver must never
    // take the pod down with it.
    log(`[bundle-ota] ❌ unexpected resolver error: ${(err as Error).message} — falling through`);
  }

  // 4. resolve: current pointer (valid + not blacklisted) → bundle; else builtin.
  const current = readPointer(root, 'current');
  if (current && !isBlacklisted(root, current)) {
    const dir = bundleDir(root, current);
    const proof = readVerifiedRuntimeMetadata(root, current);
    if (isValidBundleDir(dir) && proof?.previous === readPointer(root, 'previous')) {
      // Arm the crash-detection marker for THIS boot; the daemon confirms it
      // (clearBootMarker + boot_ok) after a stability window.
      armBootMarker(root, current);
      log(`[bundle-ota] resolved: bundle v${current} (${dir})`);
      return { execPath: join(dir, 'dist', 'cli.js'), dir, version: current, source: 'bundle', applied };
    }
    log(`[bundle-ota] current pointer → v${current} lacks a valid matching proof, falling to builtin`);
  }
  log('[bundle-ota] resolved: builtin runtime');
  return { execPath: null, dir: null, version: deps.builtinVersion ?? 'builtin', source: 'builtin', applied };
}

// ── boot confirmation (runs inside the booted daemon) ────────────────────────

/** Resolve this running runtime's own package version (bundle or builtin). */
export function resolveOwnRuntimeVersion(): string | null {
  const require = createRequire(import.meta.url);
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/cli.js (tsup single-file) → ../package.json; src/daemon/ota/ (tsx/tests)
  // → ../../../package.json.
  for (const candidate of ['../package.json', '../../../package.json']) {
    try {
      const pkg = require(join(here, candidate)) as { name?: string; version?: string };
      if (pkg?.name === '@prismer/runtime' && typeof pkg.version === 'string') return pkg.version;
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * Confirm a bundle boot: clear the crash-detection marker + the version's
 * failure record, and report `boot_ok`. No-op when no marker is armed (builtin
 * boot, desktop host, local dev) or when the marker belongs to a DIFFERENT
 * version than the running runtime (never confirm someone else's attempt).
 */
export async function confirmBundleBoot(overrides?: Partial<OtaDeps>): Promise<boolean> {
  const home = overrides?.home ?? resolvePaths().root;
  const root = bundleRoot(home);
  const marker = readBootMarker(root);
  if (!marker) return false;
  const own = resolveOwnRuntimeVersion();
  if (own && own !== marker.version) return false;
  clearBootMarker(root);
  clearBootFailures(root, marker.version);
  const deps = bootDepsFromEnvironment(home, overrides);
  await reportOta(deps, 'boot_ok', { daemonVersion: marker.version });
  deps.log?.(`[bundle-ota] boot confirmed for v${marker.version}`);
  return true;
}

/**
 * Schedule `confirmBundleBoot` after the stability window. Fire-and-forget;
 * called by the daemon CLI right after `runner.start()` succeeds. A crash
 * inside the window leaves the marker armed ⇒ the next boot's resolver counts
 * the strike and rolls back.
 */
export function scheduleBundleBootConfirm(delayMs: number = BOOT_CONFIRM_DELAY_MS): void {
  const timer = setTimeout(() => {
    void confirmBundleBoot().catch(() => undefined);
  }, delayMs);
  // Never keep the process alive just for telemetry.
  timer.unref?.();
}

/**
 * Assemble OtaDeps from config.toml + env, best-effort (the resolver must work
 * before/without a config: no cloudBase ⇒ offline resolve, still never bricks).
 */
export function bootDepsFromEnvironment(home: string, overrides?: Partial<OtaDeps>): OtaDeps {
  let cloudBase: string | undefined = process.env.PRISMER_BASE_URL;
  let daemonId: string | undefined = process.env.PRISMER_DAEMON_ID;
  const apiKey = normalizeRuntimeApiKey(process.env.PRISMER_API_KEY);
  try {
    const cfg = loadConfig(resolvePaths(home));
    cloudBase = cloudBase ?? cfg.cloud_api_base;
    daemonId = daemonId ?? cfg.daemon_id;
  } catch {
    /* pre-setup boot — env-only */
  }
  return {
    home,
    cloudBase,
    daemonId,
    apiKey,
    channel: process.env.PRISMER_BUNDLE_CHANNEL,
    manifestUrl: process.env.PRISMER_BUNDLE_MANIFEST_URL,
    builtinVersion: resolveOwnRuntimeVersion() ?? undefined,
    log: (line) => process.stderr.write(`${line}\n`),
    ...overrides,
  };
}
