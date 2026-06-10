// docs/release201/31 §4.1 #4 — lie-detector regex behaviour lock (no mocks).
//
// Pure-function test of the file-claim patterns (release201/30 §8). Locks the
// positive/negative behaviour so a future regex edit that widens/narrows the
// match trips here. Patterns live in ws/lie-detector.ts (extracted from
// handler.ts for testability).

import { describe, expect, it } from 'vitest';
import { detectAgentFileClaim, LIE_PATTERNS } from '../ws/lie-detector';

describe('detectAgentFileClaim (release201/30 §8 telemetry patterns)', () => {
  it('matches Chinese file-generation claims', () => {
    for (const s of [
      '已生成 报告.pdf 放在群里',
      '已经完成了 PPTX 输出',
      '文件已上传到 /tmp/out',
      '已作为附件发送给你',
      'PDF 文件已 12 页',
    ]) {
      expect(detectAgentFileClaim(s)).toBe(true);
    }
  });

  it('matches English file-generation claims', () => {
    for (const s of [
      'Created the report.pdf for you',
      'Attached the spreadsheet to this message',
      'Generated slides.pptx in the workspace',
    ]) {
      expect(detectAgentFileClaim(s)).toBe(true);
    }
  });

  it('does NOT match ordinary replies / sub-threshold text', () => {
    for (const s of [
      '好的，我来看看这个问题',
      'Let me think about the architecture',
      'the pdf format is widely supported', // mentions pdf but no generation claim
      'abc', // < 4 chars
      '',
    ]) {
      expect(detectAgentFileClaim(s)).toBe(false);
    }
  });

  it('exposes exactly the 8 documented patterns (drift lock)', () => {
    expect(LIE_PATTERNS).toHaveLength(8);
  });
});
