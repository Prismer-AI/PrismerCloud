/**
 * Prismer IM — Safe JSON Parsing Utility
 *
 * Wraps JSON.parse in try-catch to safely handle malformed JSON.
 * Used across services for parsing stored metadata and capabilities.
 */

/**
 * Safely parse JSON with a default fallback value.
 * If input is already the expected type (not a string), returns it directly.
 */
export function safeJsonParse<T>(input: string | T | null | undefined, defaultValue: T): T {
  if (input == null) return defaultValue;
  if (typeof input !== 'string') return input;
  try {
    return JSON.parse(input) as T;
  } catch {
    return defaultValue;
  }
}
