import { describe, expect, it } from 'vitest';

import {
  MAX_DOCUMENT_PREVIEW_BYTES,
  MAX_TABLE_PREVIEW_BYTES,
  MAX_TEXT_PREVIEW_BYTES,
  previewGateLabel,
  previewInlineSizeLimit,
} from '../asset-preview-limits';

describe('asset preview size gates', () => {
  it('allows Office and PDF previews up to the document limit', () => {
    expect(
      previewInlineSizeLimit({
        isTabular: false,
        isPdf: false,
        isOffice: true,
        shouldFetchText: false,
        usesDuckDB: false,
        textPreviewLimit: MAX_TEXT_PREVIEW_BYTES,
      }),
    ).toBe(MAX_DOCUMENT_PREVIEW_BYTES);

    expect(
      previewInlineSizeLimit({
        isTabular: false,
        isPdf: true,
        isOffice: false,
        shouldFetchText: false,
        usesDuckDB: false,
        textPreviewLimit: MAX_TEXT_PREVIEW_BYTES,
      }),
    ).toBe(MAX_DOCUMENT_PREVIEW_BYTES);
  });

  it('uses the table limit for tabular and DuckDB previews', () => {
    expect(
      previewInlineSizeLimit({
        isTabular: true,
        isPdf: false,
        isOffice: false,
        shouldFetchText: true,
        usesDuckDB: false,
        textPreviewLimit: MAX_TEXT_PREVIEW_BYTES,
      }),
    ).toBe(MAX_TABLE_PREVIEW_BYTES);

    expect(
      previewInlineSizeLimit({
        isTabular: false,
        isPdf: false,
        isOffice: false,
        shouldFetchText: false,
        usesDuckDB: true,
        textPreviewLimit: MAX_TEXT_PREVIEW_BYTES,
      }),
    ).toBe(MAX_TABLE_PREVIEW_BYTES);
  });

  it('keeps plain text previews on the text limit', () => {
    expect(
      previewInlineSizeLimit({
        isTabular: false,
        isPdf: false,
        isOffice: false,
        shouldFetchText: true,
        usesDuckDB: false,
        textPreviewLimit: MAX_TEXT_PREVIEW_BYTES,
      }),
    ).toBe(MAX_TEXT_PREVIEW_BYTES);
  });

  it('uses format-aware error labels', () => {
    expect(
      previewGateLabel({
        isTabular: false,
        isPdf: false,
        isOffice: true,
        usesDuckDB: false,
        baseLabel: 'Text preview',
        officeLabel: 'PowerPoint preview',
      }),
    ).toBe('PowerPoint preview');

    expect(
      previewGateLabel({
        isTabular: true,
        isPdf: false,
        isOffice: false,
        usesDuckDB: false,
        baseLabel: 'Text preview',
        officeLabel: 'Office preview',
      }),
    ).toBe('Table preview');
  });
});
