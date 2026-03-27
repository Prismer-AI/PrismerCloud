/**
 * Input Detector - 自动检测输入类型
 *
 * 用于 Load API 智能判断输入是:
 * - 单个 URL
 * - URL 数组 (批量)
 * - Query 搜索文本
 */

export type InputType = 'single_url' | 'batch_urls' | 'query' | 'prismer_uri';

export interface DetectionResult {
  type: InputType;
  urls?: string[]; // 对于 URL 类型
  query?: string; // 对于 Query 类型
  original: string | string[];
}

/**
 * 检测字符串是否为有效 URL
 */
function isValidUrl(str: string): boolean {
  if (!str || typeof str !== 'string') return false;

  try {
    const url = new URL(str.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 自动检测输入类型
 *
 * @param input - 输入内容 (string 或 string[])
 * @param forceType - 强制指定类型 (可选)
 * @returns DetectionResult
 */
export function detectInputType(
  input: string | string[],
  forceType?: 'auto' | 'url' | 'urls' | 'query',
): DetectionResult {
  // 强制指定类型
  if (forceType && forceType !== 'auto') {
    if (forceType === 'url') {
      const url = Array.isArray(input) ? input[0] : input;
      return {
        type: 'single_url',
        urls: [url],
        original: input,
      };
    }
    if (forceType === 'urls') {
      const urls = Array.isArray(input) ? input : [input];
      return {
        type: 'batch_urls',
        urls,
        original: input,
      };
    }
    if (forceType === 'query') {
      const query = Array.isArray(input) ? input.join(' ') : input;
      return {
        type: 'query',
        query,
        original: input,
      };
    }
  }

  // 自动检测

  // Case 1: 数组输入 → 批量 URL
  if (Array.isArray(input)) {
    return {
      type: 'batch_urls',
      urls: input.filter((u) => typeof u === 'string').map((u) => u.trim()),
      original: input,
    };
  }

  // Case 2: 字符串输入
  const trimmed = input.trim();

  // 检测 prismer:// 内部 URI
  if (trimmed.startsWith('prismer://')) {
    return { type: 'prismer_uri', urls: [trimmed], original: input };
  }

  // 检测是否为 URL
  if (isValidUrl(trimmed)) {
    return {
      type: 'single_url',
      urls: [trimmed],
      original: input,
    };
  }

  // Case 3: 非 URL → Query 搜索
  return {
    type: 'query',
    query: trimmed,
    original: input,
  };
}

/**
 * 验证输入是否有效
 */
export function validateInput(input: unknown): { valid: boolean; error?: string } {
  if (input === undefined || input === null) {
    return { valid: false, error: 'input is required' };
  }

  if (typeof input === 'string') {
    if (input.trim().length === 0) {
      return { valid: false, error: 'input cannot be empty' };
    }
    return { valid: true };
  }

  if (Array.isArray(input)) {
    if (input.length === 0) {
      return { valid: false, error: 'input array cannot be empty' };
    }
    if (input.length > 50) {
      return { valid: false, error: 'input array cannot exceed 50 items' };
    }
    const invalidItems = input.filter((item) => typeof item !== 'string' || !item.trim());
    if (invalidItems.length > 0) {
      return { valid: false, error: 'all items in input array must be non-empty strings' };
    }
    return { valid: true };
  }

  return { valid: false, error: 'input must be a string or array of strings' };
}
