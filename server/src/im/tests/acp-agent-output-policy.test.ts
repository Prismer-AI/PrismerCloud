import { describe, expect, it } from 'vitest';

import { validateAgentOutputAsset } from '../services/agent-output-policy';

const MB = 1024 * 1024;

describe('validateAgentOutputAsset — release202/09 P0 allowlist', () => {
  it('allows the office-artifacts deliverables (pdf/docx/xlsx/pptx) — the 20-day 422 fix', () => {
    const cases: Array<{ filename: string; mime: string; category: string }> = [
      { filename: 'Prismer-Cloud-Product-Intro.pdf', mime: 'application/pdf', category: 'document' },
      {
        filename: 'report.docx',
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        category: 'document',
      },
      {
        filename: 'data.xlsx',
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        category: 'document',
      },
      {
        filename: 'deck.pptx',
        mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        category: 'document',
      },
      { filename: 'legacy.doc', mime: 'application/msword', category: 'document' },
      { filename: 'legacy.xls', mime: 'application/vnd.ms-excel', category: 'document' },
      { filename: 'legacy.ppt', mime: 'application/vnd.ms-powerpoint', category: 'document' },
    ];
    for (const { filename, mime, category } of cases) {
      const result = validateAgentOutputAsset({ filename, mime, sizeBytes: 1 * MB });
      expect(result, `${filename} should pass`).toMatchObject({ ok: true, category });
    }
  });

  it('infers office mimes from the filename when the producer omits mime', () => {
    const result = validateAgentOutputAsset({ filename: 'report.pdf', mime: null, sizeBytes: 1 * MB });
    expect(result).toMatchObject({ ok: true, category: 'document', mime: 'application/pdf' });
  });

  it('allows raster images (png/jpg/jpeg/gif/webp) and keeps svg working', () => {
    for (const filename of ['chart.png', 'photo.jpg', 'photo.jpeg', 'anim.gif', 'art.webp']) {
      const result = validateAgentOutputAsset({ filename, mime: null, sizeBytes: 1 * MB });
      expect(result, `${filename} should pass`).toMatchObject({ ok: true, category: 'image' });
    }
    const svg = validateAgentOutputAsset({ filename: 'diagram.svg', mime: 'image/svg+xml', sizeBytes: 1024 });
    expect(svg).toMatchObject({ ok: true });
  });

  it('allows .zip archives', () => {
    const result = validateAgentOutputAsset({ filename: 'bundle.zip', mime: 'application/zip', sizeBytes: 5 * MB });
    expect(result).toMatchObject({ ok: true, category: 'archive' });
  });

  it('keeps text/code/csv rules intact', () => {
    expect(validateAgentOutputAsset({ filename: 'notes.md', mime: null, sizeBytes: 1024 })).toMatchObject({
      ok: true,
      category: 'text',
    });
    expect(validateAgentOutputAsset({ filename: 'main.ts', mime: null, sizeBytes: 1024 })).toMatchObject({
      ok: true,
      category: 'code',
    });
    expect(validateAgentOutputAsset({ filename: 'rows.csv', mime: null, sizeBytes: 1024 })).toMatchObject({
      ok: true,
      category: 'data',
    });
  });

  it('still blocks real executables and dangerous archives', () => {
    for (const filename of ['malware.exe', 'lib.dll', 'lib.so', 'app.dmg', 'run.bat', 'pkg.tar', 'x.gz', 'a.7z']) {
      const result = validateAgentOutputAsset({ filename, mime: null, sizeBytes: 1024 });
      expect(result.ok, `${filename} should be blocked`).toBe(false);
    }
  });

  it('still blocks video/audio and non-raster images (tiff/bmp)', () => {
    expect(validateAgentOutputAsset({ filename: 'clip.mp4', mime: 'video/mp4', sizeBytes: 1024 }).ok).toBe(false);
    expect(validateAgentOutputAsset({ filename: 'song.mp3', mime: 'audio/mpeg', sizeBytes: 1024 }).ok).toBe(false);
    expect(validateAgentOutputAsset({ filename: 'scan.tiff', mime: 'image/tiff', sizeBytes: 1024 }).ok).toBe(false);
    expect(validateAgentOutputAsset({ filename: 'old.bmp', mime: 'image/bmp', sizeBytes: 1024 }).ok).toBe(false);
  });

  it('enforces the raised per-category caps (document 50MB / image 25MB / archive 30MB) under a 50MB hard cap', () => {
    expect(validateAgentOutputAsset({ filename: 'big.pdf', mime: 'application/pdf', sizeBytes: 45 * MB }).ok).toBe(true);
    expect(validateAgentOutputAsset({ filename: 'huge.png', mime: 'image/png', sizeBytes: 30 * MB })).toMatchObject({
      ok: false,
    });
    expect(validateAgentOutputAsset({ filename: 'over.pdf', mime: 'application/pdf', sizeBytes: 60 * MB })).toMatchObject(
      { ok: false, reason: 'agent output exceeds 50 MB hard limit' },
    );
  });
});
