/**
 * agentskills.io-compliant SKILL.md frontmatter parser & validator.
 *
 * Spec source: https://agentskills.io/specification
 *
 * v2.1 §A.7 — replaces the regex parser in built-in-skill.service.ts which
 * only read `name` + `description` and silently ignored `license`, `metadata`,
 * `compatibility`, `allowed-tools` (cf. evaluator A5 spike). This module is
 * the single source of frontmatter parsing across:
 *   • BuiltInSkillService (sdk/built-in-skills/* → IMSkill upsert)
 *   • evolution.ts export-skill route (gene → IMSkill emit)
 *   • skills.ts user-create endpoints (multipart payload validation)
 *   • daemon-side validation (mirror import via shared types)
 */

import { parse as parseYaml } from 'yaml';

/**
 * Fields recognised by the agentskills.io spec. Only `name` is strictly
 * required for the manifest layer to work — every other field is best-effort.
 *
 * `metadata` is intentionally `Record<string, unknown>` (free-form per spec).
 */
export interface FrontmatterFields {
  name?: string;
  description?: string;
  license?: string;
  compatibility?: string | string[];
  metadata?: Record<string, unknown>;
  'allowed-tools'?: string | string[];
  // Keep raw to allow downstream consumers to inspect unknown fields without
  // re-parsing the YAML body.
  raw?: Record<string, unknown>;
}

export interface ParseResult {
  fm: FrontmatterFields;
  body: string;
  errors: string[];
}

// agentskills.io name spec:
// • lowercase alphanumeric + hyphen
// • starts with a letter
// • ends with a letter or digit
// • length 1..64
// Single character `[a-z]` is also a legal name (the spec doesn't forbid it).
const NAME_REGEX = /^(?:[a-z]|[a-z][a-z0-9-]{0,62}[a-z0-9])$/;
const DESCRIPTION_MAX = 1024;

/**
 * Match leading `---\n…\n---\n?` block.
 *
 * Matches CRLF as well (some Windows authors). The trailing newline after the
 * closing `---` is optional so that an empty-body file still parses.
 */
const FRONTMATTER_DELIM_REGEX = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/;

export function parseFrontmatter(content: string): ParseResult {
  const empty: ParseResult = { fm: {}, body: content, errors: [] };
  if (typeof content !== 'string') return { ...empty, errors: ['content must be a string'] };

  const match = content.match(FRONTMATTER_DELIM_REGEX);
  if (!match) return empty;

  const fmText = match[1] ?? '';
  const body = content.slice(match[0].length);

  let raw: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(fmText);
    if (parsed === null || parsed === undefined) {
      // empty frontmatter block — treat as no fields, not an error
      raw = {};
    } else if (typeof parsed === 'object' && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>;
    } else {
      return { fm: {}, body, errors: ['frontmatter must be a YAML mapping at top level'] };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { fm: {}, body, errors: [`YAML parse error: ${msg}`] };
  }

  const errors: string[] = [];
  const fm: FrontmatterFields = { raw };

  // name (required if present in spec; we surface error but still return body)
  if ('name' in raw) {
    const v = raw.name;
    if (typeof v !== 'string') {
      errors.push('name must be a string');
    } else {
      const trimmed = v.trim();
      if (!NAME_REGEX.test(trimmed)) {
        errors.push(
          `name "${trimmed}" must be 1-64 lowercase letters/digits/hyphens, starting with a letter and ending with a letter or digit`,
        );
      }
      fm.name = trimmed;
    }
  }

  // description
  if ('description' in raw) {
    const v = raw.description;
    if (typeof v !== 'string') {
      errors.push('description must be a string');
    } else {
      if (v.length > DESCRIPTION_MAX) {
        errors.push(`description must be ≤ ${DESCRIPTION_MAX} characters (got ${v.length})`);
      }
      fm.description = v;
    }
  }

  // license — spec allows free-form string ("MIT", "Apache-2.0", "Complete terms in LICENSE.txt")
  if ('license' in raw) {
    const v = raw.license;
    if (typeof v !== 'string') {
      errors.push('license must be a string');
    } else {
      fm.license = v.trim();
    }
  }

  // compatibility — string or string[]
  if ('compatibility' in raw) {
    const v = raw.compatibility;
    if (typeof v === 'string') {
      fm.compatibility = v.trim();
    } else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
      fm.compatibility = v as string[];
    } else {
      errors.push('compatibility must be a string or array of strings');
    }
  }

  // metadata — must be an object/mapping
  if ('metadata' in raw) {
    const v = raw.metadata;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      fm.metadata = v as Record<string, unknown>;
    } else {
      errors.push('metadata must be a YAML mapping');
    }
  }

  // allowed-tools — string (comma-sep or YAML list) or array
  if ('allowed-tools' in raw) {
    const v = raw['allowed-tools'];
    if (typeof v === 'string') {
      fm['allowed-tools'] = v;
    } else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
      fm['allowed-tools'] = v as string[];
    } else {
      errors.push('allowed-tools must be a string or array of strings');
    }
  }

  return { fm, body, errors };
}

/**
 * Validate that the frontmatter `name` matches the directory name on disk.
 *
 * agentskills.io requires `name == basename(dir)` so that a skill's filesystem
 * identity (the import slug) matches its self-declared name. Skills that omit
 * `name` aren't compliant but we accept them as warning-only — we don't
 * synthesise a name silently.
 */
export function validateAgainstDirName(fm: FrontmatterFields, dirName: string): string[] {
  const errors: string[] = [];
  if (!fm.name) {
    errors.push(`frontmatter.name is missing (dir: ${dirName})`);
    return errors;
  }
  if (fm.name !== dirName) {
    errors.push(`frontmatter.name "${fm.name}" must equal directory name "${dirName}"`);
  }
  return errors;
}

// Re-export validators so call-sites importing from this module pick up future
// helpers (e.g. validateAllowedToolsAgainstPolicy) without churning their import list.
export const NAME_PATTERN = NAME_REGEX;
export const DESCRIPTION_MAX_LENGTH = DESCRIPTION_MAX;
