/**
 * Minimal glob matcher extracted from permission-engine.ts.
 * Supports the three pattern shapes used in FROZEN_GLOBS and fsSearch:
 *   **\/*.ext    -- any path ending with .ext
 *   **\/.env*   -- any path where a segment starts with .env
 *   **\/prefix.* -- any path where basename matches prefix.*
 *   *           -- any single-segment wildcard (no path separator)
 *
 * Deliberately avoids adding minimatch as a runtime dependency.
 * This module is the single source of truth — permission-engine.ts
 * and fs-adapter.ts both import from here.
 */

/**
 * Test whether filePath matches glob.
 * - **\/ matches any depth prefix (zero or more segments).
 * - * within a segment matches any characters except slash.
 * - ** alone (without trailing slash) matches anything.
 */
export function matchGlob(glob: string, filePath: string): boolean {
  // Steps:
  // 1. Escape regex metacharacters except * (not a regex meta).
  // 2. Replace ** with a placeholder before handling single *.
  // 3. Map **/ to an optional any-depth prefix.
  // 4. Map bare ** to .*.
  // 5. Map * to single-segment wildcard [^/]*.
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex specials (. + ^ $ etc.) -- NOT *
    .replace(/\*\*/g, '\u0000')            // ** -> placeholder (must precede single-* replacement)
    .replace(/\*/g, '[^/]*')              // * -> single-segment wildcard
    .replace(/\u0000\//g, '(?:.+/)?')     // **/ -> optional any-depth prefix
    .replace(/\u0000/g, '.*');            // ** alone -> anything

  return new RegExp(`^${escaped}$`).test(filePath);
}
