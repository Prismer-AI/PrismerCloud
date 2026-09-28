// WebUploadAdapter — marker class; actual upload happens cloud-side.
// Verifies the SPI shape conformance + the documented invariants.

import { describe, expect, it } from 'vitest';
import {
  WebUploadAdapter,
  WEB_UPLOAD_ORIGIN_KIND,
  isWebUploadSourceKind,
} from '../src/daemon/asset/origin/web-upload.js';

describe('WebUploadAdapter (cloud-side marker)', () => {
  it('declares kind = upload', () => {
    expect(WEB_UPLOAD_ORIGIN_KIND).toBe('upload');
    const a = new WebUploadAdapter();
    expect(a.kind).toBe('upload');
  });

  it('observe() throws — daemon does not poll Web uploads', async () => {
    const a = new WebUploadAdapter();
    const iter = a.observe()[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toThrow(/cloud-side/);
  });

  it('identifySource() throws — Web uploads are identified by the cloud handler', async () => {
    const a = new WebUploadAdapter();
    await expect(
      a.identifySource({ workspaceId: 'w', detail: {}, observedAt: 0 }),
    ).rejects.toThrow(/cloud-side/);
  });

  it('fetch() throws — bytes live in cloud storage, not on daemon disk', async () => {
    const a = new WebUploadAdapter();
    await expect(a.fetch({ workspaceId: 'w', detail: {}, observedAt: 0 })).rejects.toThrow(
      /cloud-side/,
    );
  });

  it('isWebUploadSourceKind matches what the cloud-side multipart handler stamps', () => {
    expect(isWebUploadSourceKind('upload')).toBe(true);
    expect(isWebUploadSourceKind('drop-folder')).toBe(false);
    expect(isWebUploadSourceKind('agent-gen')).toBe(false);
    expect(isWebUploadSourceKind(null)).toBe(false);
    expect(isWebUploadSourceKind(undefined)).toBe(false);
  });
});
