/**
 * release-ota-promote.test.ts — 真验证（治 doc01 #8：**线 3 交付模式必须是 drain_respawn，不是 kill1**）。
 *
 * 副作用 oracle（验收纪律 §1）：断言取自结构化 envelope 字段（`k8s.directive` / `k8s.frame` /
 * `deliveryMode`），不断言聊天文本。核心不变量：K8s 通道下发 `directive:'drain_respawn'`（排空在飞后
 * respawn，无中断），**绝不出现 kill1 / `kubectl exec kill 1` / 线 1 runtime-ota.ts**。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { localManifestPath, resolveLocalComponentUrl } from '../../../../apps/desktop/electron/ota-feed';
import {
  ADMIN_ROLLOUT_ENDPOINT,
  buildDrainRespawnRollout,
  DRAIN_RESPAWN_DIRECTIVE,
  promoteDesktopLocalFeed,
  RUNTIME_UPDATE_APPLY_FRAME,
} from '../release-ota-promote';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const APC = 'sdk/apc/bin/apc.ts';
const TIMEOUT = 60_000;

function apc(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('npx', ['tsx', APC, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: TIMEOUT,
    env: { ...process.env, ...env },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('buildDrainRespawnRollout / desktop local feed', () => {
  it('线 3 交付指令 = drain_respawn（不是 kill1），落点 = admin fleet rollout endpoint', () => {
    const r = buildDrainRespawnRollout('9.9.9');
    // 核心不变量：交付模式 drain_respawn（副作用 oracle）
    expect(r.directive).toBe(DRAIN_RESPAWN_DIRECTIVE);
    expect(r.directive).toBe('drain_respawn');
    expect(r.frame).toBe(RUNTIME_UPDATE_APPLY_FRAME);
    expect(r.endpoint).toBe(ADMIN_ROLLOUT_ENDPOINT);
    expect(r.channel).toBe('admin-fleet-rollout');
    // 本机替身边界：不真 POST
    expect(r.posted).toBe(false);
    expect(r.request.version).toBe('9.9.9');
    // 负控形状：整个请求里绝不出现 kill1 / runtime-ota 线 1 痕迹
    const blob = JSON.stringify(r);
    expect(blob).not.toContain('kill1');
    expect(blob).not.toContain('kill 1');
    expect(blob).not.toContain('runtime-ota');
  });
  it('从签名 bundle 元数据 plan→apply，并以 feed manifest + bundle 回读为准', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'apc-desktop-feed-'));
    const sourceDir = resolve(root, 'source');
    const feedDir = resolve(root, 'feed');
    const bundle = Buffer.from('signed-ui-bundle');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(resolve(sourceDir, 'ui.zip'), bundle);
    const metaPath = resolve(sourceDir, 'ui.manifest.json');
    writeFileSync(
      metaPath,
      JSON.stringify({
        component: 'ui',
        version: '9.9.9.1',
        file: 'ui.zip',
        sha512: createHash('sha512').update(bundle).digest('hex'),
        sig: 'test-ed25519-signature',
        size: bundle.length,
        minAppVersion: '9.9.9',
      }),
    );

    const result = promoteDesktopLocalFeed({ feedDir, uiMetaPath: metaPath });

    expect(result.status).toBe('applied');
    expect(result.readback).toMatchObject({ verified: true, decision: 'ota', versions: { ui: '9.9.9.1' } });
    const manifest = JSON.parse(readFileSync(resolve(feedDir, 'manifest.json'), 'utf8'));
    expect(manifest.components.ui.url).toBe('ui.zip');
    expect(readFileSync(resolve(feedDir, 'ui.zip'))).toEqual(bundle);
    // 跨 Electron 承接边界：它会从同一路径读 manifest，并只把 feed 内相对 URL 转成 file://。
    const electronManifest = localManifestPath({ PRISMER_UPDATE_FEED_DIR: feedDir });
    expect(electronManifest).toBe(resolve(feedDir, 'manifest.json'));
    expect(resolveLocalComponentUrl(feedDir, manifest.components.ui.url)).toBe(`file://${resolve(feedDir, 'ui.zip')}`);
    expect(resolveLocalComponentUrl(feedDir, 'https://updates.example/ui.zip')).toBeNull();
    expect(resolveLocalComponentUrl(feedDir, '../outside.zip')).toBeNull();
  });

  it('负控：同一版本文件名若字节漂移则拒绝覆盖，旧 feed 保持可读', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'apc-desktop-feed-immutable-'));
    const sourceDir = resolve(root, 'source');
    const feedDir = resolve(root, 'feed');
    const bundlePath = resolve(sourceDir, 'ui.zip');
    const metaPath = resolve(sourceDir, 'ui.manifest.json');
    mkdirSync(sourceDir, { recursive: true });
    const writeArtifact = (bytes: Buffer) => {
      writeFileSync(bundlePath, bytes);
      writeFileSync(
        metaPath,
        JSON.stringify({
          component: 'ui',
          version: '9.9.9.1',
          file: 'ui.zip',
          sha512: createHash('sha512').update(bytes).digest('hex'),
          sig: 'test-ed25519-signature',
          size: bytes.length,
          minAppVersion: '9.9.9',
        }),
      );
    };
    const original = Buffer.from('first-immutable-bundle');
    writeArtifact(original);
    expect(promoteDesktopLocalFeed({ feedDir, uiMetaPath: metaPath }).status).toBe('applied');

    writeArtifact(Buffer.from('mutated-same-version-bundle'));
    const second = promoteDesktopLocalFeed({ feedDir, uiMetaPath: metaPath });

    expect(second.status).toBe('blocked');
    expect(second.status === 'blocked' ? second.blockers.join() : '').toContain('不可变');
    expect(readFileSync(resolve(feedDir, 'ui.zip'))).toEqual(original);
  });
});

describe('apc release ota-promote — 线 3 drain_respawn（治 doc01 #8）', () => {
  it('CLI 将桌面通道真写本地 feed 并返回结构化 readback，不触远端', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'apc-desktop-cli-feed-'));
    const sourceDir = resolve(root, 'source');
    const feedDir = resolve(root, 'feed');
    mkdirSync(sourceDir, { recursive: true });
    const bundle = Buffer.from('signed-daemon-bundle');
    writeFileSync(resolve(sourceDir, 'daemon.zip'), bundle);
    const metaPath = resolve(sourceDir, 'daemon.manifest.json');
    writeFileSync(
      metaPath,
      JSON.stringify({
        component: 'daemon',
        version: '9.9.9',
        file: 'daemon.zip',
        sha512: createHash('sha512').update(bundle).digest('hex'),
        sig: 'test-ed25519-signature',
        size: bundle.length,
        minAppVersion: '9.9.9',
      }),
    );

    const r = apc([
      'release',
      'ota-promote',
      '--env',
      'dev',
      '--desktop-feed-dir',
      feedDir,
      '--desktop-daemon-meta',
      metaPath,
      '--json',
    ]);
    const j = JSON.parse(r.stdout);

    expect(r.status).toBe(1); // K8s 真 POST 仍按 M5 边界 blocked；不能拿桌面成功掩盖它。
    expect(j.desktop).toMatchObject({
      status: 'applied',
      deliveryMode: 'local-file-feed',
      readback: { verified: true, decision: 'ota', versions: { daemon: '9.9.9' } },
    });
    expect(j.desktop.boundary).toContain('不等于 Electron 已 check/stage/apply');
    expect(readFileSync(resolve(feedDir, 'daemon.zip'))).toEqual(bundle);
  }, TIMEOUT);

  it('K8s 通道交付 drain_respawn（非 kill1），本机替身 dry-run 不 POST → blocked', () => {
    const r = apc(['release', 'ota-promote', '--env', 'dev', '--json'], { PRISMER_UPDATE_FEED_DIR: '' });
    const j = JSON.parse(r.stdout);
    // ── 核心 oracle：交付模式是 drain_respawn，不是 kill1 ──
    expect(j.k8s.directive).toBe('drain_respawn');
    expect(j.k8s.frame).toBe('runtime.update.apply');
    expect(j.k8s.channel).toBe('admin-fleet-rollout');
    expect(j.deliveryMode).toContain('drain_respawn');
    // ── 负控：交付 payload（k8s 对象）+ deliveryMode 绝不含 kill1 / kubectl kill / 线 1 runtime-ota 痕迹 ──
    // 只扫交付面（notes 是解释「不再走 kill1」的散文，不是下发信号，不纳入负控）。
    const delivery = JSON.stringify(j.k8s) + '\n' + j.deliveryMode;
    expect(delivery).not.toContain('kill1');
    expect(delivery).not.toContain('kill 1');
    expect(delivery).not.toContain('[runtime-ota]');
    expect(delivery).not.toContain('runtime-ota');
    // ── 本机替身边界：不真 POST，诚实 blocked（不宣称 drain_respawn 已执行）──
    expect(j.k8s.posted).toBe(false);
    expect(j.decision).toBe('blocked');
    expect(r.status).toBe(1);
    // 未给本地 feed 时诚实 blocked，不会回退到 Nacos/远端。
    expect(j.desktop.status).toBe('blocked');
    // drain_respawn 在 notes 声明为线 3 正规路径
    expect(j.notes.join()).toContain('drain_respawn');
  }, TIMEOUT);

  it('负控 / prod 人闸：--env prod → blocked，且 K8s/桌面均无副作用', () => {
    const feedDir = resolve(mkdtempSync(resolve(tmpdir(), 'apc-prod-feed-')), 'feed');
    const r = apc(['release', 'ota-promote', '--env', 'prod', '--desktop-feed-dir', feedDir, '--json']);
    expect(r.status).toBe(1);
    const j = JSON.parse(r.stdout);
    expect(j.decision).toBe('blocked');
    expect(j.k8s.skipped).toBe(true); // 未构造 rollout 请求
    expect(j.blockers.join()).toContain('prod 人闸');
    expect(existsSync(feedDir)).toBe(false);
    // prod 路径不应出现交付指令（证明真的没下发）
    expect(JSON.stringify(j.k8s)).not.toContain('drain_respawn');
  }, TIMEOUT);
});
