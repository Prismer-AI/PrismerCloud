/**
 * Prismer IM — Asset Blob Store (pure blob I/O primitives)
 *
 * Content-addressed (sha256) blob read/write + storage-URI/CDN helpers,
 * shared by the assets API (`src/im/api/assets.ts`) and any service-layer
 * code that needs to materialize asset bytes (e.g. the task result
 * materializer — release201/3x).
 *
 * Why this module exists (layer rule): `src/im/api/*` may import
 * `src/im/services/*`, never the reverse. The task layer
 * (`task.service.ts`, a service) must NOT reach into `api/assets.ts`. To let
 * both surfaces share ONE copy of the blob write logic, the pure I/O
 * primitives live here and `assets.ts` imports them (api → service, the
 * allowed direction). This module deliberately has **no Prisma dependency**
 * — it only deals with bytes, filesystem paths, and S3 keys. Row creation /
 * index-seq allocation / metadata stays with the respective callers.
 *
 * Backend selected at runtime via process.env.ASSET_STORAGE_BACKEND:
 *   - "filesystem" (default): writes to ASSET_STORAGE_DIR (default OS temp),
 *      sharded <dir>/<hash[0..2]>/<hash[2..4]>/<hash>. storageUri = file://<abs>.
 *   - "s3": writes to getBucket(); key assets/<hash[0..2]>/<hash[2..4]>/<hash>.
 *      storageUri = s3://<bucket>/<key>.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { config } from '../config';
import { getBucket, putS3Object } from './s3.client';

/** Per-blob hard cap (1 GB). Shared with the upload path's pre-write guard. */
export const MAX_ASSET_BYTES = 1024 * 1024 * 1024;

export function getBackend(): 'filesystem' | 's3' {
  return process.env.ASSET_STORAGE_BACKEND === 's3' ? 's3' : 'filesystem';
}

export function getStorageDir(): string {
  if (process.env.ASSET_STORAGE_DIR) return path.resolve(process.env.ASSET_STORAGE_DIR);
  return path.join(os.tmpdir(), 'prismer-cloud-assets');
}

export function shardedKey(hash: string): string {
  return `${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
}

export function assetS3KeyForContentHash(hash: string): string {
  return `assets/${shardedKey(hash)}`;
}

export function assetCdnUrlForS3Key(key: string): string | null {
  const domain = config.cdn.domain.trim();
  if (!domain) return null;
  const base = domain.startsWith('http') ? domain : `https://${domain}`;
  const normalizedBase = base.replace(/\/+$/, '');
  const normalizedKey = key
    .replace(/^\/+/, '')
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  return `${normalizedBase}/${normalizedKey}`;
}

export function assetCdnUrlForStorageUri(storageUri: string): string | null {
  const match = storageUri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) return null;
  return assetCdnUrlForS3Key(match[2]);
}

export async function writeFilesystem(hash: string, bytes: Buffer): Promise<string> {
  const dir = getStorageDir();
  const subdir = path.join(dir, hash.slice(0, 2), hash.slice(2, 4));
  await fs.promises.mkdir(subdir, { recursive: true });
  const filePath = path.join(subdir, hash);
  // Idempotent: if file already exists with matching size, skip rewrite.
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size === bytes.length) {
      return `file://${filePath}`;
    }
  } catch {
    // not present, write below
  }
  await fs.promises.writeFile(filePath, bytes);
  return `file://${filePath}`;
}

export async function writeS3(hash: string, bytes: Buffer, mime: string | null): Promise<string> {
  const bucket = getBucket();
  const key = assetS3KeyForContentHash(hash);
  await putS3Object({
    bucket,
    key,
    body: bytes,
    contentType: mime,
    contentHashSha256Hex: hash,
  });
  return `s3://${bucket}/${key}`;
}

/**
 * Backend-aware blob write. Picks filesystem | s3 from getBackend() and
 * returns the canonical storageUri. Callers that need S3 but lack creds
 * should check `isS3Available()` (from s3.client) before invoking.
 */
export async function writeAssetBytes(hash: string, bytes: Buffer, mime: string | null): Promise<string> {
  return getBackend() === 's3' ? writeS3(hash, bytes, mime) : writeFilesystem(hash, bytes);
}
