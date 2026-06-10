export const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024;
export const MAX_TEXT_PREVIEW_CHARS = 80_000;
export const MAX_VIRTUAL_TEXT_PREVIEW_BYTES = 5 * 1024 * 1024;
export const MAX_VIRTUAL_TEXT_PREVIEW_CHARS = 2_000_000;
export const MAX_TABLE_PREVIEW_BYTES = 20 * 1024 * 1024;
export const MAX_TABLE_TEXT_PREVIEW_BYTES = MAX_TABLE_PREVIEW_BYTES;
export const MAX_TABLE_TEXT_PREVIEW_CHARS = 10_000_000;
export const MAX_DOCUMENT_PREVIEW_BYTES = 50 * 1024 * 1024;
export const MAX_SPREADSHEET_PREVIEW_BYTES = MAX_TABLE_PREVIEW_BYTES;

export interface PreviewInlineLimitFlags {
  isTabular: boolean;
  isPdf: boolean;
  isOffice: boolean;
  shouldFetchText: boolean;
  usesDuckDB: boolean;
  textPreviewLimit: number;
}

export function previewInlineSizeLimit(flags: PreviewInlineLimitFlags): number {
  if (flags.isTabular || flags.usesDuckDB) return MAX_TABLE_PREVIEW_BYTES;
  if (flags.isOffice || flags.isPdf) return MAX_DOCUMENT_PREVIEW_BYTES;
  if (flags.shouldFetchText) return flags.textPreviewLimit;
  return Number.POSITIVE_INFINITY;
}

export interface PreviewGateLabelFlags {
  isTabular: boolean;
  isPdf: boolean;
  isOffice: boolean;
  usesDuckDB: boolean;
  baseLabel: string;
  officeLabel: string;
}

export function previewGateLabel(flags: PreviewGateLabelFlags): string {
  if (flags.isTabular || flags.usesDuckDB) return 'Table preview';
  if (flags.isPdf) return 'PDF preview';
  if (flags.isOffice) return flags.officeLabel;
  return flags.baseLabel;
}
