/**
 * Prismer IM — File Content Validation Pipeline
 *
 * Validates uploaded files before CDN activation.
 * Runs on the first bytes of the uploaded object to detect actual content type
 * via magic bytes, block executables, and prevent MIME spoofing.
 *
 * Pipeline order:
 * 1. Extension blocklist check
 * 2. Magic bytes detection (file-type)
 * 3. MIME whitelist check
 * 4. MIME mismatch detection
 * 5. Executable signature scan (PE/ELF/Mach-O)
 * 6. Compression bomb check
 * 7. Size consistency check
 */

import { fromBuffer } from 'file-type';
import path from 'path';

// ─── Constants ──────────────────────────────────────────

export const MIME_WHITELIST = new Set([
  // Images
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  // Documents
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  // Office
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',   // .docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',         // .xlsx
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
  // Data
  'application/json',
  'application/xml',
  'text/xml',
  // Archives
  'application/zip',
  'application/gzip',
  'application/x-gzip',
]);

/** Extensions to extension-based MIME mapping (for text files without magic bytes) */
const TEXT_EXTENSION_MAP: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
};

export const BLOCKED_EXTENSIONS = new Set([
  // Executables
  '.exe', '.dll', '.bat', '.cmd', '.com', '.msi', '.scr', '.pif',
  // Scripts
  '.sh', '.bash', '.csh', '.ksh',
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.php', '.py', '.rb', '.pl', '.ps1', '.vbs', '.wsf',
  // Web (XSS risk)
  '.html', '.htm', '.xhtml', '.svg', '.svgz',
  // Other dangerous
  '.jar', '.class', '.war',
  '.app', '.dmg', '.pkg',
  '.deb', '.rpm',
]);

// Executable magic byte signatures
const PE_SIGNATURE = Buffer.from([0x4d, 0x5a]);                     // MZ (Windows PE)
const ELF_SIGNATURE = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);       // \x7fELF (Linux)
const MACHO_BE_SIGNATURE = Buffer.from([0xfe, 0xed, 0xfa, 0xce]);   // Mach-O big-endian
const MACHO_LE_SIGNATURE = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);   // Mach-O little-endian
const MACHO_FAT_SIGNATURE = Buffer.from([0xca, 0xfe, 0xba, 0xbe]);  // Mach-O fat binary

/** Maximum compression ratio before flagging as potential bomb */
const MAX_COMPRESSION_RATIO = 100;

// ─── Types ──────────────────────────────────────────────

export interface ValidationInput {
  /** First N bytes of the file (8KB recommended) */
  headBytes: Buffer;
  /** Original filename */
  fileName: string;
  /** Client-declared MIME type */
  declaredMimeType: string;
  /** Client-declared file size in bytes */
  declaredSize: number;
  /** Actual size from storage (S3 HEAD or filesystem stat) */
  actualSize: number;
}

export interface ValidationResult {
  valid: boolean;
  /** MIME type detected from magic bytes (or inferred from extension for text) */
  detectedMimeType: string;
  /** Error message if invalid */
  error?: string;
  /** Machine-readable error code */
  errorCode?: FileValidationError;
}

export type FileValidationError =
  | 'BLOCKED_EXTENSION'
  | 'BLOCKED_MIME_TYPE'
  | 'MIME_MISMATCH'
  | 'EXECUTABLE_DETECTED'
  | 'COMPRESSION_BOMB'
  | 'SIZE_MISMATCH'
  | 'EMPTY_FILE';

// ─── Validation Pipeline ────────────────────────────────

/**
 * Run the full validation pipeline on file content.
 */
export async function validateFileContent(input: ValidationInput): Promise<ValidationResult> {
  const { headBytes, fileName, declaredMimeType, declaredSize, actualSize } = input;

  // 0. Empty file check
  if (actualSize === 0) {
    return fail('EMPTY_FILE', 'File is empty');
  }

  // 1. Extension blocklist
  const ext = path.extname(fileName).toLowerCase();
  if (BLOCKED_EXTENSIONS.has(ext)) {
    return fail('BLOCKED_EXTENSION', `File extension "${ext}" is not allowed`);
  }

  // 2. Executable signature scan (before MIME detection — catches renamed executables)
  if (headBytes.length >= 4) {
    if (headBytes.subarray(0, 2).equals(PE_SIGNATURE)) {
      return fail('EXECUTABLE_DETECTED', 'Windows executable (PE) detected');
    }
    if (headBytes.subarray(0, 4).equals(ELF_SIGNATURE)) {
      return fail('EXECUTABLE_DETECTED', 'Linux executable (ELF) detected');
    }
    if (
      headBytes.subarray(0, 4).equals(MACHO_BE_SIGNATURE) ||
      headBytes.subarray(0, 4).equals(MACHO_LE_SIGNATURE) ||
      headBytes.subarray(0, 4).equals(MACHO_FAT_SIGNATURE)
    ) {
      return fail('EXECUTABLE_DETECTED', 'macOS executable (Mach-O) detected');
    }
  }

  // 3. Magic bytes detection
  let detectedMimeType: string;
  const fileTypeResult = await fromBuffer(headBytes);

  if (fileTypeResult) {
    detectedMimeType = fileTypeResult.mime;
  } else {
    // No magic bytes — likely a text-based file. Infer from extension.
    detectedMimeType = TEXT_EXTENSION_MAP[ext] || 'application/octet-stream';
  }

  // 4. MIME whitelist check
  if (!MIME_WHITELIST.has(detectedMimeType)) {
    // Office files detected by file-type as application/zip — check extension
    if (detectedMimeType === 'application/zip' && isOfficeExtension(ext)) {
      detectedMimeType = officeExtensionToMime(ext);
    } else if (detectedMimeType === 'application/octet-stream') {
      return fail('BLOCKED_MIME_TYPE', `Could not determine file type for "${fileName}"`);
    } else {
      return fail('BLOCKED_MIME_TYPE', `File type "${detectedMimeType}" is not allowed`);
    }
  }

  // 5. MIME mismatch check (relaxed: allow compatible types)
  if (!areMimeTypesCompatible(declaredMimeType, detectedMimeType)) {
    return fail(
      'MIME_MISMATCH',
      `Declared type "${declaredMimeType}" does not match detected type "${detectedMimeType}"`
    );
  }

  // 6. Compression bomb check
  if (isCompressedType(detectedMimeType) && declaredSize > 0) {
    // For compressed files, we can't check decompressed size from head bytes alone.
    // Instead, flag if the actual size is wildly different from declared size.
    if (actualSize > 0 && actualSize > declaredSize * MAX_COMPRESSION_RATIO) {
      return fail('COMPRESSION_BOMB', 'Potential compression bomb detected');
    }
  }

  // 7. Size consistency check
  if (declaredSize > 0 && actualSize > 0) {
    // Allow 1% tolerance for encoding differences
    const sizeDiff = Math.abs(actualSize - declaredSize);
    const tolerance = Math.max(1024, declaredSize * 0.01);
    if (sizeDiff > tolerance) {
      return fail(
        'SIZE_MISMATCH',
        `Declared size (${declaredSize}) differs from actual size (${actualSize})`
      );
    }
  }

  return { valid: true, detectedMimeType };
}

/**
 * Quick pre-flight check: validates fileName and mimeType before creating upload record.
 * Does NOT require file content — only checks metadata.
 */
export function validateUploadRequest(
  fileName: string,
  fileSize: number,
  mimeType: string,
  maxSize: number,
): string | null {
  if (!fileName || fileName.length > 255) {
    return 'fileName must be 1-255 characters';
  }
  if (/[/\\:\0]/.test(fileName)) {
    return 'fileName must not contain path separators or null bytes';
  }
  if (fileSize <= 0) {
    return 'fileSize must be greater than 0';
  }
  if (fileSize > maxSize) {
    return `fileSize exceeds maximum (${Math.round(maxSize / 1024 / 1024)}MB)`;
  }
  const ext = path.extname(fileName).toLowerCase();
  if (BLOCKED_EXTENSIONS.has(ext)) {
    return `File extension "${ext}" is not allowed`;
  }
  if (!MIME_WHITELIST.has(mimeType)) {
    // Check if it's an Office MIME from a known extension
    if (isOfficeExtension(ext)) {
      return null; // Allow — will be validated more thoroughly on confirm
    }
    return `MIME type "${mimeType}" is not allowed`;
  }
  return null;
}

/**
 * Sanitize a filename for safe storage. Strips dangerous characters.
 */
export function sanitizeFileName(name: string): string {
  return name
    .replace(/[/\\:\0<>"|?*]/g, '_')  // Replace dangerous chars
    .replace(/\.{2,}/g, '.')          // Collapse double dots
    .replace(/^\./g, '_')             // No hidden files
    .trim()
    .slice(0, 200);                   // Truncate
}

// ─── Helpers ────────────────────────────────────────────

function fail(errorCode: FileValidationError, error: string): ValidationResult {
  return { valid: false, detectedMimeType: '', error, errorCode };
}

function isOfficeExtension(ext: string): boolean {
  return ['.docx', '.xlsx', '.pptx'].includes(ext);
}

function officeExtensionToMime(ext: string): string {
  const map: Record<string, string> = {
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  return map[ext] || 'application/zip';
}

function isCompressedType(mime: string): boolean {
  return mime === 'application/zip' || mime === 'application/gzip' || mime === 'application/x-gzip';
}

/**
 * Check if two MIME types are compatible.
 * Allows minor variations (e.g., text/xml vs application/xml).
 */
function areMimeTypesCompatible(declared: string, detected: string): boolean {
  if (declared === detected) return true;

  // Normalize
  const d = declared.toLowerCase();
  const t = detected.toLowerCase();
  if (d === t) return true;

  // Allow text/* declared with matching detected
  if (d.startsWith('text/') && t.startsWith('text/')) return true;

  // XML variants
  if ((d === 'text/xml' || d === 'application/xml') && (t === 'text/xml' || t === 'application/xml')) return true;

  // gzip variants
  if ((d === 'application/gzip' || d === 'application/x-gzip') && (t === 'application/gzip' || t === 'application/x-gzip')) return true;

  // Office files detected as application/zip is OK
  if (t === 'application/zip' && d.includes('openxmlformats')) return true;
  if (d === 'application/zip' && t.includes('openxmlformats')) return true;

  // Binary fallback: allow if declared is in whitelist and detected is octet-stream (text files)
  if (t === 'application/octet-stream' && MIME_WHITELIST.has(d)) return true;

  return false;
}
