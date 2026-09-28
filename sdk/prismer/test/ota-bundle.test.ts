// ota-bundle.test.ts — boot-time runtime-bundle OTA (product204/08 §2.3, M9-β).
//
// Full-chain drill against a REAL local HTTP server (manifest + zip + incident
// report sink), a REAL throwaway ed25519 keypair, and REAL system zip/unzip:
//   1. old daemon boot → manifest offers new version → download → sha256 +
//      ed25519 verify → unzip → pointer switch → resolution = new bundle +
//      `applied` report; confirm → `boot_ok` report (熔断统计分母).
//   2. 负控: tampered zip → verify MUST reject (no extract, no pointer move,
//      builtin resolution) + `verify_failed` incident payload asserted.
//   3. boot-failure injection: armed marker never confirmed → strike + rollback
//      to the previous slot (`boot_failed` + `rolled_back`), second strike →
//      blacklist (dir removed, manifest re-offer refused).

import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, sign as cryptoSign, createHash, type KeyObject } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  confirmBundleBoot,
  reportCapabilityIncident,
  runBootOta,
  type OtaDeps,
} from '../src/daemon/ota/ota-check.js';
import {
  armBootMarker,
  bundleDir,
  bundleRoot,
  clearBootMarker,
  isBlacklisted,
  readBootMarker,
  readPointer,
  readVerifiedRuntimeMetadata,
  writeVerifiedRuntimeMetadata,
  writePointer,
} from '../src/daemon/ota/bundle-store.js';
import { verifyBundleSignature } from '../src/daemon/ota/pubkey.js';

// ── fixtures ──────────────────────────────────────────────────────────────────

const NEW_VERSION = '9.9.9';
const OLD_VERSION = '8.8.8';

interface Fixture {
  home: string;
  server: Server;
  baseUrl: string;
  pubkeyB64: string;
  privateKey: KeyObject;
  zipBytes: Buffer;
  sig: string;
  sha256: string;
  sha512: string;
  reports: Array<Record<string, unknown>>;
  reportAuthorizations: Array<string | undefined>;
  manifestAuthorizations: Array<string | undefined>;
  manifestRequests: string[];
  bundleAuthorizations: Array<string | undefined>;
  artifactAuthorizations: Array<string | undefined>;
  manifest: () => unknown; // swappable per test
  serveZip: () => Buffer; //  swappable per test (tamper injection)
}

let fx: Fixture;

function stagePkfRuntimeFloor(staging: string, version: string): void {
  for (const slug of ['pkf-writing', 'pkf-svg']) {
    mkdirSync(join(staging, 'built-in-skills', slug), { recursive: true });
    writeFileSync(
      join(staging, 'built-in-skills', slug, 'SKILL.md'),
      `---\nname: ${slug}\n---\n# ${slug}\n`,
    );
  }
  mkdirSync(join(staging, 'node_modules', '@prismer', 'pkf'), { recursive: true });
  writeFileSync(
    join(staging, 'node_modules', '@prismer', 'pkf', 'package.json'),
    JSON.stringify({ name: '@prismer/pkf', version: '0.3.0', main: 'index.js' }),
  );
  writeFileSync(join(staging, 'node_modules', '@prismer', 'pkf', 'index.js'), 'module.exports = {};\n');
  const sdkRoot = join(staging, 'node_modules', '@prismer', 'sdk');
  mkdirSync(join(sdkRoot, 'dist'), { recursive: true });
  writeFileSync(
    join(sdkRoot, 'package.json'),
    JSON.stringify({ name: '@prismer/sdk', version, main: 'dist/index.js', bin: { cloud: 'dist/cli.js' } }),
  );
  writeFileSync(join(sdkRoot, 'dist', 'index.js'), 'module.exports = {};\n');
  writeFileSync(join(sdkRoot, 'dist', 'cli.js'), '#!/usr/bin/env node\nconsole.log("fixture cloud cli")\n');
  chmodSync(join(sdkRoot, 'dist', 'cli.js'), 0o755);
  mkdirSync(join(staging, 'node_modules', '@earendil-works', 'pi-agent-core'), { recursive: true });
  writeFileSync(
    join(staging, 'node_modules', '@earendil-works', 'pi-agent-core', 'package.json'),
    JSON.stringify({ name: '@earendil-works/pi-agent-core', version: '0.84.2' }),
  );
  mkdirSync(join(staging, 'node_modules', '@earendil-works', 'pi-ai'), { recursive: true });
  writeFileSync(
    join(staging, 'node_modules', '@earendil-works', 'pi-ai', 'package.json'),
    JSON.stringify({ name: '@earendil-works/pi-ai', version: '0.84.2' }),
  );
  mkdirSync(join(staging, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(
    join(staging, 'node_modules', '.bin', 'cloud'),
    '#!/usr/bin/env node\nconsole.log("fixture bounded cloud api")\n',
  );
  chmodSync(join(staging, 'node_modules', '.bin', 'cloud'), 0o755);
}

function buildBundleZip(
  dir: string,
  version: string,
  blockProofWrite = false,
  omitEntry?: string,
): Buffer {
  const staging = join(dir, `staging-${version}`);
  mkdirSync(join(staging, 'dist'), { recursive: true });
  writeFileSync(join(staging, 'dist', 'cli.js'), `console.log('fixture bundle v${version}');\n`);
  writeFileSync(
    join(staging, 'package.json'),
    JSON.stringify({ name: '@prismer/runtime', version, type: 'module' }),
  );
  // 2026-07-20 — BUNDLE_REQUIRED_ENTRIES now pins the hermes MemoryProvider
  // shell; a memory-less bundle is not usable (the 2026-07-19 regression).
  mkdirSync(join(staging, 'plugins', 'memory', 'prismer'), { recursive: true });
  writeFileSync(join(staging, 'plugins', 'memory', 'prismer', '__init__.py'), '# fixture provider shell\n');
  // 2026-07-26 — BUNDLE_REQUIRED_ENTRIES also pins apc/skills (desktop205 D8);
  // the packers stage apc/ at the zip root so resolveApcSkillsRoot() finds it
  // one hop above dist/. Same reason as plugins/ above.
  mkdirSync(join(staging, 'apc', 'skills', 'fixture-skill'), { recursive: true });
  writeFileSync(join(staging, 'apc', 'skills', 'fixture-skill', 'SKILL.md'), '---\nscope: coding\n---\n');
  stagePkfRuntimeFloor(staging, version);
  if (omitEntry) rmSync(join(staging, omitEntry), { recursive: true, force: true });
  if (blockProofWrite) mkdirSync(join(staging, 'verified-runtime.json'));
  const zipPath = join(dir, `bundle-${version}.zip`);
  // Entries at zip ROOT (dist/, package.json) — same layout as
  // apps/desktop/scripts/build-daemon-bundle.cjs produces.
  execFileSync('zip', ['-r', '-qq', zipPath, '.'], { cwd: staging });
  return readFileSync(zipPath);
}

/** Materialize an extracted old bundle on disk + point `current` at it. */
function installOldBundle(home: string): void {
  const root = bundleRoot(home);
  const dir = bundleDir(root, OLD_VERSION);
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'cli.js'), `console.log('fixture bundle v${OLD_VERSION}');\n`);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@prismer/runtime', version: OLD_VERSION }));
  // Post-2026-07-20 world: every usable bundle carries the provider shell
  // (BUNDLE_REQUIRED_ENTRIES) — without it the rollback slot would floor to
  // builtin instead of previous, which is the intended behaviour for the
  // legacy memory-less bundles but not what this fixture represents.
  mkdirSync(join(dir, 'plugins', 'memory', 'prismer'), { recursive: true });
  writeFileSync(join(dir, 'plugins', 'memory', 'prismer', '__init__.py'), '# fixture provider shell\n');
  // Same for apc/skills (desktop205 D8, 2026-07-26): this fixture stands for a
  // CURRENT-contract bundle, so it must satisfy the current required entries.
  mkdirSync(join(dir, 'apc', 'skills', 'fixture-skill'), { recursive: true });
  writeFileSync(join(dir, 'apc', 'skills', 'fixture-skill', 'SKILL.md'), '---\nscope: coding\n---\n');
  stagePkfRuntimeFloor(dir, OLD_VERSION);
  writePointer(root, 'current', OLD_VERSION);
  writeVerifiedRuntimeMetadata(root, OLD_VERSION, {
    version: OLD_VERSION,
    current: OLD_VERSION,
    previous: null,
    sha256: 'a'.repeat(64),
    signatureSha256: 'b'.repeat(64),
  });
}

function deps(overrides?: Partial<OtaDeps>): OtaDeps {
  return {
    home: fx.home,
    cloudBase: fx.baseUrl,
    daemonId: 'container:test-pod-0',
    apiKey: 'runtime-test-api-key',
    channel: 'k8s',
    manifestUrl: `${fx.baseUrl}/api/runtime/update/manifest`,
    pubkeyB64: fx.pubkeyB64,
    builtinVersion: '2.0.9',
    manifestTimeoutMs: 2_000,
    downloadTimeoutMs: 5_000,
    log: () => undefined,
    ...overrides,
  };
}

beforeEach(async () => {
  const home = mkdtempSync(join(tmpdir(), 'ota-test-'));
  const scratch = mkdtempSync(join(tmpdir(), 'ota-zip-'));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubkeyB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const zipBytes = buildBundleZip(scratch, NEW_VERSION);
  const sig = cryptoSign(null, zipBytes, privateKey).toString('base64');
  const sha256 = createHash('sha256').update(zipBytes).digest('hex');
  const sha512 = createHash('sha512').update(zipBytes).digest('hex');
  const reports: Array<Record<string, unknown>> = [];
  const reportAuthorizations: Array<string | undefined> = [];
  const manifestAuthorizations: Array<string | undefined> = [];
  const manifestRequests: string[] = [];
  const bundleAuthorizations: Array<string | undefined> = [];
  const artifactAuthorizations: Array<string | undefined> = [];

  fx = {
    home,
    baseUrl: '',
    pubkeyB64,
    privateKey,
    zipBytes,
    sig,
    sha256,
    sha512,
    reports,
    reportAuthorizations,
    manifestAuthorizations,
    manifestRequests,
    bundleAuthorizations,
    artifactAuthorizations,
    manifest: () => ({
      version: NEW_VERSION,
      url: `${fx.baseUrl}/bundles/bundle-${NEW_VERSION}.zip`,
      sha256,
      signature: sig,
      rollout: { percent: 100 },
    }),
    serveZip: () => fx.zipBytes,
    server: createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/api/runtime/update/manifest') {
        fx.manifestAuthorizations.push(req.headers.authorization);
        fx.manifestRequests.push(url.toString());
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(fx.manifest()));
        return;
      }
      if (url.pathname.startsWith('/bundles/')) {
        fx.artifactAuthorizations.push(req.headers.authorization);
        res.end(fx.serveZip());
        return;
      }
      if (url.pathname.startsWith('/api/runtime/update/bundle/')) {
        fx.bundleAuthorizations.push(req.headers.authorization);
        res.end(fx.serveZip());
        return;
      }
      if (url.pathname === '/api/runtime/update/report' && req.method === 'POST') {
        fx.reportAuthorizations.push(req.headers.authorization);
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString()));
        req.on('end', () => {
          try {
            reports.push(JSON.parse(body) as Record<string, unknown>);
          } catch {
            reports.push({ unparseable: body });
          }
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: true, stored: true }));
        });
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    }),
  };
  await new Promise<void>((resolve) => fx.server.listen(0, '127.0.0.1', resolve));
  const addr = fx.server.address();
  if (!addr || typeof addr === 'string') throw new Error('server address');
  fx.baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => fx.server.close(() => resolve()));
  rmSync(fx.home, { recursive: true, force: true });
});

const outcomes = () => fx.reports.map((r) => r.outcome);

// ── tests ─────────────────────────────────────────────────────────────────────

describe('runBootOta — happy path (检查→下载→验签→解包→切换)', () => {
  it('pulls, verifies (sha256 + ed25519), extracts, switches pointer, arms marker, reports applied', async () => {
    installOldBundle(fx.home);
    const root = bundleRoot(fx.home);

    const res = await runBootOta(deps());

    expect(res.source).toBe('bundle');
    expect(res.version).toBe(NEW_VERSION);
    expect(res.applied).toBe(true);
    expect(res.execPath).toBe(join(root, NEW_VERSION, 'dist', 'cli.js'));
    expect(existsSync(res.execPath!)).toBe(true);
    // pointer switch + rollback slot (回滚位).
    expect(readPointer(root, 'current')).toBe(NEW_VERSION);
    expect(readPointer(root, 'previous')).toBe(OLD_VERSION);
    expect(readVerifiedRuntimeMetadata(root, NEW_VERSION)).toEqual({
      schemaVersion: 1,
      version: NEW_VERSION,
      current: NEW_VERSION,
      previous: OLD_VERSION,
      sha256: fx.sha256,
      signatureSha256: createHash('sha256').update(Buffer.from(fx.sig, 'base64')).digest('hex'),
      verified: true,
    });
    expect(statSync(join(bundleDir(root, NEW_VERSION), 'verified-runtime.json')).mode & 0o777).toBe(0o640);
    expect(existsSync(bundleDir(root, OLD_VERSION))).toBe(true);
    // crash-detection marker armed for this boot.
    expect(readBootMarker(root)?.version).toBe(NEW_VERSION);
    // extracted package.json version gate passed.
    const pkg = JSON.parse(readFileSync(join(root, NEW_VERSION, 'package.json'), 'utf8')) as { version: string };
    expect(pkg.version).toBe(NEW_VERSION);
    for (const entry of [
      'node_modules/@prismer/pkf/package.json',
      'node_modules/@prismer/sdk/package.json',
      'node_modules/@prismer/sdk/dist/cli.js',
      'node_modules/@earendil-works/pi-agent-core/package.json',
      'node_modules/@earendil-works/pi-ai/package.json',
      'built-in-skills/pkf-writing/SKILL.md',
      'built-in-skills/pkf-svg/SKILL.md',
    ]) {
      expect(existsSync(join(root, NEW_VERSION, entry)), entry).toBe(true);
    }
    expect(statSync(join(root, NEW_VERSION, 'node_modules', '@prismer', 'sdk', 'dist', 'cli.js')).mode & 0o111).not.toBe(0);
    // incident denominator: `applied` reported with the right identity fields.
    expect(outcomes()).toContain('applied');
    const applied = fx.reports.find((r) => r.outcome === 'applied')!;
    expect(applied.component).toBe('daemon');
    expect(applied.daemonId).toBe('container:test-pod-0');
    expect(applied.daemonVersion).toBe(NEW_VERSION);
    expect(applied.previousVersion).toBe(OLD_VERSION);
    expect(applied.channel).toBe('k8s');
    expect(fx.reportAuthorizations).toContain('Bearer runtime-test-api-key');
    expect(fx.manifestAuthorizations).toContain('Bearer runtime-test-api-key');
    expect(fx.artifactAuthorizations).toEqual([undefined]);
  });

  it('authenticates only the Cloud-owned bundle capability URL', async () => {
    fx.manifest = () => ({
      version: NEW_VERSION,
      url: `${fx.baseUrl}/api/runtime/update/bundle/${NEW_VERSION}?channel=daemon&testChallenge=challenge-1`,
      sha256: fx.sha256,
      signature: fx.sig,
    });

    const result = await runBootOta(deps());

    expect(result.version).toBe(NEW_VERSION);
    expect(fx.bundleAuthorizations).toEqual(['Bearer runtime-test-api-key']);
    expect(fx.artifactAuthorizations).toHaveLength(0);
  });

  it('does not emit anonymous OTA reports when no runtime API key is available', async () => {
    const lines: string[] = [];
    await runBootOta(deps({ apiKey: '', log: (line) => lines.push(line) }));

    expect(fx.reports).toHaveLength(0);
    expect(fx.reportAuthorizations).toHaveLength(0);
    expect(lines).toContain('[bundle-ota] report skipped: runtime API key unavailable');
  });

  it('verifies the legacy desktop manifest shape (components.daemon + sha512 + sig)', async () => {
    fx.manifest = () => ({
      decision: 'ota',
      components: {
        daemon: { version: NEW_VERSION, url: `${fx.baseUrl}/bundles/x.zip`, sha512: fx.sha512, sig: fx.sig },
      },
    });
    const res = await runBootOta(deps());
    expect(res.source).toBe('bundle');
    expect(res.version).toBe(NEW_VERSION);
  });

  it('refuses a lower flat-manifest target unless the decision is explicit rollback', async () => {
    const lowerBytes = buildBundleZip(join(fx.home, 'lower-ota-fixture'), OLD_VERSION);
    const lowerSig = cryptoSign(null, lowerBytes, fx.privateKey).toString('base64');
    fx.serveZip = () => lowerBytes;
    fx.manifest = () => ({
      decision: 'ota',
      version: OLD_VERSION,
      url: `${fx.baseUrl}/bundles/lower.zip`,
      sha256: createHash('sha256').update(lowerBytes).digest('hex'),
      signature: lowerSig,
    });

    const res = await runBootOta(deps({ builtinVersion: NEW_VERSION }));

    expect(res).toMatchObject({ source: 'builtin', version: NEW_VERSION, applied: false });
    expect(fx.artifactAuthorizations).toHaveLength(0);
  });

  it('does not let a corrupt higher pointer block a forward OTA from the builtin floor', async () => {
    const root = bundleRoot(fx.home);
    writePointer(root, 'current', '99.99.99');

    const res = await runBootOta(deps({ builtinVersion: OLD_VERSION }));

    expect(res).toMatchObject({ source: 'bundle', version: NEW_VERSION, applied: true });
    expect(new URL(fx.manifestRequests.at(-1)!).searchParams.get('current')).toBe(OLD_VERSION);
  });

  it('applies a lower flat-manifest target when the server explicitly authorizes rollback', async () => {
    const lowerBytes = buildBundleZip(join(fx.home, 'lower-rollback-fixture'), OLD_VERSION);
    const lowerSig = cryptoSign(null, lowerBytes, fx.privateKey).toString('base64');
    fx.serveZip = () => lowerBytes;
    fx.manifest = () => ({
      decision: 'rollback',
      version: OLD_VERSION,
      url: `${fx.baseUrl}/bundles/lower.zip`,
      sha256: createHash('sha256').update(lowerBytes).digest('hex'),
      signature: lowerSig,
    });

    const res = await runBootOta(deps({ builtinVersion: NEW_VERSION }));

    expect(res).toMatchObject({ source: 'bundle', version: OLD_VERSION, applied: true });
  });

  it('confirmBundleBoot clears the marker + failure record and reports boot_ok', async () => {
    await runBootOta(deps());
    const root = bundleRoot(fx.home);
    expect(readBootMarker(root)).not.toBeNull();

    // The fixture bundle's version (9.9.9) differs from the running runtime's
    // own package version — assert the mismatch guard first (never confirm
    // someone else's attempt)…
    const own = (await import('../src/daemon/ota/ota-check.js')).resolveOwnRuntimeVersion();
    expect(own).not.toBe(NEW_VERSION);
    expect(
      await confirmBundleBoot({
        home: fx.home,
        cloudBase: fx.baseUrl,
        daemonId: 'container:test-pod-0',
        apiKey: 'runtime-test-api-key',
      }),
    ).toBe(false);
    // …then simulate the marker belonging to the running version and confirm.
    armBootMarker(root, own!);
    expect(
      await confirmBundleBoot({
        home: fx.home,
        cloudBase: fx.baseUrl,
        daemonId: 'container:test-pod-0',
        apiKey: 'runtime-test-api-key',
      }),
    ).toBe(true);
    expect(readBootMarker(root)).toBeNull();
    expect(outcomes()).toContain('boot_ok');
  });

  it('is a no-op when already on the offered version (steady state re-arms the marker only)', async () => {
    await runBootOta(deps());
    // Steady state presumes the previous boot CONFIRMED (marker cleared by the
    // daemon); an unconfirmed marker is by design a strike, not steady state.
    clearBootMarker(bundleRoot(fx.home));
    fx.reports.length = 0;
    const res = await runBootOta(deps());
    expect(res.applied).toBe(false);
    expect(res.version).toBe(NEW_VERSION);
    expect(outcomes()).not.toContain('applied');
    expect(readBootMarker(bundleRoot(fx.home))?.version).toBe(NEW_VERSION); // re-armed
  });
});

describe('runBootOta — 负控 (verify-or-die)', () => {
  it('validly signed bundle missing one canonical PKF skill is rejected after extraction', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'ota-pkf-floor-tamper-'));
    const bytes = buildBundleZip(
      scratch,
      NEW_VERSION,
      false,
      'built-in-skills/pkf-svg/SKILL.md',
    );
    const signature = cryptoSign(null, bytes, fx.privateKey).toString('base64');
    fx.serveZip = () => bytes;
    fx.manifest = () => ({
      version: NEW_VERSION,
      url: `${fx.baseUrl}/bundles/missing-pkf-svg.zip`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      signature,
    });

    const res = await runBootOta(deps());

    expect(res.source).toBe('builtin');
    expect(existsSync(bundleDir(bundleRoot(fx.home), NEW_VERSION))).toBe(false);
    const failed = fx.reports.find((report) => report.outcome === 'boot_failed');
    expect(String(failed?.reason)).toContain('apply-failed');
    rmSync(scratch, { recursive: true, force: true });
  });

  it('tampered zip → signature rejected, NOTHING extracted, builtin resolution, verify_failed incident', async () => {
    const tampered = Buffer.from(fx.zipBytes);
    tampered[tampered.length - 10] ^= 0xff;
    fx.serveZip = () => tampered;
    // sha256 in the manifest matches the TAMPERED bytes → hash passes, only the
    // signature stands between the attacker and execution.
    fx.manifest = () => ({
      version: NEW_VERSION,
      url: `${fx.baseUrl}/bundles/x.zip`,
      sha256: createHash('sha256').update(tampered).digest('hex'),
      signature: fx.sig,
    });

    const res = await runBootOta(deps());

    const root = bundleRoot(fx.home);
    expect(res.source).toBe('builtin');
    expect(res.execPath).toBeNull();
    expect(existsSync(bundleDir(root, NEW_VERSION))).toBe(false); // never extracted
    expect(readPointer(root, 'current')).toBeNull(); // pointer untouched
    expect(readVerifiedRuntimeMetadata(root, NEW_VERSION)).toBeNull();
    // incident payload shape (cloud route vocabulary, component=daemon).
    const vf = fx.reports.find((r) => r.outcome === 'verify_failed');
    expect(vf).toBeDefined();
    expect(vf!.component).toBe('daemon');
    expect(vf!.daemonVersion).toBe(NEW_VERSION);
    expect(vf!.reason).toBe('signature-invalid');
  });

  it('sha256 mismatch → rejected before signature check, no extract', async () => {
    fx.manifest = () => ({
      version: NEW_VERSION,
      url: `${fx.baseUrl}/bundles/x.zip`,
      sha256: 'deadbeef'.repeat(8),
      signature: fx.sig,
    });
    const res = await runBootOta(deps());
    expect(res.source).toBe('builtin');
    expect(fx.reports.find((r) => r.outcome === 'verify_failed')!.reason).toBe('sha256-mismatch');
  });

  it('offer without any content hash → rejected', async () => {
    fx.manifest = () => ({ version: NEW_VERSION, url: `${fx.baseUrl}/bundles/x.zip`, signature: fx.sig });
    const res = await runBootOta(deps());
    expect(res.source).toBe('builtin');
    expect(fx.reports.find((r) => r.outcome === 'verify_failed')!.reason).toBe('no-content-hash');
  });

  it('extracted package.json version ≠ offered version → apply rejected + dir removed', async () => {
    // Offer claims 7.7.7 but the signed zip carries 9.9.9 — version-drift gate.
    fx.manifest = () => ({
      version: '7.7.7',
      url: `${fx.baseUrl}/bundles/x.zip`,
      sha256: fx.sha256,
      signature: fx.sig,
    });
    const res = await runBootOta(deps());
    const root = bundleRoot(fx.home);
    expect(res.source).toBe('builtin');
    expect(existsSync(bundleDir(root, '7.7.7'))).toBe(false);
    const bf = fx.reports.find((r) => r.outcome === 'boot_failed');
    expect(String(bf!.reason)).toContain('apply-failed');
  });

  it('manifest unreachable → offline resolve keeps current bundle (local-first, never brick)', async () => {
    installOldBundle(fx.home);
    const res = await runBootOta(deps({ manifestUrl: 'http://127.0.0.1:1/manifest', manifestTimeoutMs: 300 }));
    expect(res.source).toBe('bundle');
    expect(res.version).toBe(OLD_VERSION);
  });

  it('does not execute a pointer whose bundle has no version-scoped verification proof', async () => {
    const root = bundleRoot(fx.home);
    installOldBundle(fx.home);
    rmSync(join(bundleDir(root, OLD_VERSION), 'verified-runtime.json'));
    fx.manifest = () => ({ decision: 'none' });

    const res = await runBootOta(deps());

    expect(res.source).toBe('builtin');
    expect(res.execPath).toBeNull();
  });

  it('restores the exact prior slot when verification proof cannot be persisted', async () => {
    installOldBundle(fx.home);
    const root = bundleRoot(fx.home);
    const bytes = buildBundleZip(join(fx.home, 'proof-block-fixture'), NEW_VERSION, true);
    const signature = cryptoSign(null, bytes, fx.privateKey).toString('base64');
    fx.serveZip = () => bytes;
    fx.manifest = () => ({
      version: NEW_VERSION,
      url: `${fx.baseUrl}/bundles/proof-block.zip`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      signature,
    });

    const res = await runBootOta(deps());

    expect(res.version).toBe(OLD_VERSION);
    expect(res.applied).toBe(false);
    expect(readPointer(root, 'current')).toBe(OLD_VERSION);
    expect(readPointer(root, 'previous')).toBeNull();
    expect(existsSync(bundleDir(root, NEW_VERSION))).toBe(false);
    expect(readVerifiedRuntimeMetadata(root, OLD_VERSION)?.verified).toBe(true);
  });
});

describe('runBootOta — boot-failure rollback + blacklist (回滚位 + 镜像永固)', () => {
  it('unconfirmed marker refuses an unverified previous slot and floors to builtin', async () => {
    const root = bundleRoot(fx.home);
    installOldBundle(fx.home);
    rmSync(join(bundleDir(root, OLD_VERSION), 'verified-runtime.json'));
    mkdirSync(bundleDir(root, NEW_VERSION), { recursive: true });
    writePointer(root, 'previous', OLD_VERSION);
    writePointer(root, 'current', NEW_VERSION);
    armBootMarker(root, NEW_VERSION);
    fx.manifest = () => ({ decision: 'none' });

    const res = await runBootOta(deps());

    expect(res.source).toBe('builtin');
    expect(readPointer(root, 'current')).toBeNull();
    expect(readPointer(root, 'previous')).toBe(OLD_VERSION);
  });

  it('unconfirmed marker → strike 1: rollback to previous slot, boot_failed + rolled_back reported', async () => {
    const root = bundleRoot(fx.home);
    installOldBundle(fx.home); // current=8.8.8
    // Simulate: 9.9.9 was applied last boot (previous=8.8.8, current=9.9.9,
    // marker armed) and the daemon crashed before confirming.
    mkdirSync(join(bundleDir(root, NEW_VERSION), 'dist'), { recursive: true });
    writeFileSync(join(bundleDir(root, NEW_VERSION), 'dist', 'cli.js'), 'boom');
    writeFileSync(
      join(bundleDir(root, NEW_VERSION), 'package.json'),
      JSON.stringify({ name: '@prismer/runtime', version: NEW_VERSION }),
    );
    writePointer(root, 'previous', OLD_VERSION);
    writePointer(root, 'current', NEW_VERSION);
    armBootMarker(root, NEW_VERSION);
    fx.manifest = () => ({ decision: 'none' });

    const res = await runBootOta(deps());

    expect(readPointer(root, 'current')).toBe(OLD_VERSION); // rolled back
    expect(res.source).toBe('bundle');
    expect(res.version).toBe(OLD_VERSION);
    expect(isBlacklisted(root, NEW_VERSION)).toBe(false); // one strike only
    expect(outcomes()).toContain('boot_failed');
    expect(outcomes()).toContain('rolled_back');
    const rb = fx.reports.find((r) => r.outcome === 'rolled_back')!;
    expect(rb.daemonVersion).toBe(NEW_VERSION);
    expect(rb.previousVersion).toBe(OLD_VERSION);
  });

  it('second strike → version blacklisted, dir removed, manifest re-offer refused → floors at previous', async () => {
    const root = bundleRoot(fx.home);
    installOldBundle(fx.home);

    // Strike 1: fresh apply of 9.9.9 crashes.
    await runBootOta(deps()); // applies 9.9.9, arms marker (simulated crash = no confirm)
    expect(readPointer(root, 'current')).toBe(NEW_VERSION);
    // Strike 1 settlement + re-apply (manifest still offers 9.9.9, count=1 < 2).
    await runBootOta(deps());
    expect(readPointer(root, 'current')).toBe(NEW_VERSION); // re-applied after rollback
    // Strike 2 settlement: blacklist + refuse the re-offer.
    const res = await runBootOta(deps());

    expect(isBlacklisted(root, NEW_VERSION)).toBe(true);
    expect(existsSync(bundleDir(root, NEW_VERSION))).toBe(false); // dir removed (防复活)
    expect(res.version).toBe(OLD_VERSION); // floors at the rollback slot
    expect(outcomes()).toContain('blacklisted');
  });

  it('no previous slot → rollback floors at builtin (镜像永固兜底)', async () => {
    const root = bundleRoot(fx.home);
    mkdirSync(join(bundleDir(root, NEW_VERSION), 'dist'), { recursive: true });
    writeFileSync(join(bundleDir(root, NEW_VERSION), 'dist', 'cli.js'), 'boom');
    writeFileSync(
      join(bundleDir(root, NEW_VERSION), 'package.json'),
      JSON.stringify({ name: '@prismer/runtime', version: NEW_VERSION }),
    );
    writePointer(root, 'current', NEW_VERSION);
    armBootMarker(root, NEW_VERSION);
    fx.manifest = () => ({ decision: 'none' });

    const res = await runBootOta(deps());

    expect(res.source).toBe('builtin');
    expect(res.execPath).toBeNull();
    expect(readPointer(root, 'current')).toBeNull();
  });
});

describe('capability incident authentication', () => {
  it('uses an explicit Runtime API key as Bearer authorization', async () => {
    reportCapabilityIncident('capability failed', {
      home: fx.home,
      cloudBase: fx.baseUrl,
      daemonId: 'container:test-pod-0',
      apiKey: 'explicit-runtime-key',
    });

    await vi.waitFor(() => expect(outcomes()).toContain('capability_install_failed'));
    expect(fx.reportAuthorizations).toContain('Bearer explicit-runtime-key');
  });

  it('falls back to the existing PRISMER_API_KEY Runtime credential safely', async () => {
    const previous = process.env.PRISMER_API_KEY;
    process.env.PRISMER_API_KEY = '  env-runtime-key  ';
    try {
      reportCapabilityIncident('capability failed', {
        home: fx.home,
        cloudBase: fx.baseUrl,
        daemonId: 'container:test-pod-0',
      });
      await vi.waitFor(() => expect(outcomes()).toContain('capability_install_failed'));
      expect(fx.reportAuthorizations).toContain('Bearer env-runtime-key');
    } finally {
      if (previous === undefined) delete process.env.PRISMER_API_KEY;
      else process.env.PRISMER_API_KEY = previous;
    }
  });

  it('does not construct a header from a missing or control-character credential', async () => {
    for (const apiKey of ['', 'bad\nheader']) {
      const fetchSpy = vi.fn<typeof fetch>();
      const lines: string[] = [];
      reportCapabilityIncident('capability failed', {
        home: fx.home,
        cloudBase: fx.baseUrl,
        daemonId: 'container:test-pod-0',
        apiKey,
        fetchImpl: fetchSpy,
        log: (line) => lines.push(line),
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(lines).toContain('[bundle-ota] capability incident skipped: runtime API key unavailable');
      expect(lines.join('\n')).not.toContain(apiKey || 'runtime-test-api-key');
    }
  });
});

describe('signature primitive', () => {
  it('verifyBundleSignature accepts the real sig and rejects a flipped byte', () => {
    expect(verifyBundleSignature(fx.zipBytes, fx.sig, fx.pubkeyB64)).toBe(true);
    const tampered = Buffer.from(fx.zipBytes);
    tampered[0] ^= 0x01;
    expect(verifyBundleSignature(tampered, fx.sig, fx.pubkeyB64)).toBe(false);
    expect(verifyBundleSignature(fx.zipBytes, 'not-base64!!', fx.pubkeyB64)).toBe(false);
  });
});
