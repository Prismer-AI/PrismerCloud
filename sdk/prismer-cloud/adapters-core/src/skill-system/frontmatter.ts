/**
 * SKILL.md Frontmatter Parser (L10 Skill System, v1.9.0)
 *
 * Parses YAML-style frontmatter out of a SKILL.md file per PARA §4.6.3.1:
 *
 *   ---
 *   name: deploy-prod
 *   description: ...
 *   version: 1.2.0
 *   allowed-tools: [Bash(git *), Edit(src/**)]
 *   requires:
 *     tiers: [3, 5, 7]
 *   metadata:
 *     prismer:
 *       skill_family: deployment
 *   ---
 *
 *   (body)
 *
 * This parser is deliberately tiny — it handles only the subset of YAML we
 * actually emit for skills (scalars, nested maps, flow arrays). It does NOT
 * try to be a full YAML parser. For inputs outside the supported subset it
 * throws so the caller can fall back to "invalid skill, skip".
 *
 * Return value carries both the parsed frontmatter (as a plain object) and
 * the body (the rest of the file after the closing `---`). Callers do their
 * own schema validation — this is a format-level parser, not a validator.
 */

export interface ParsedSkill {
  frontmatter: Record<string, unknown>;
  body: string;
}

const DELIMITER = /^---\s*$/;

export function parseSkillMarkdown(source: string): ParsedSkill {
  const lines = source.split(/\r?\n/);

  // File must start with `---` on the first non-empty line.
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length || !DELIMITER.test(lines[i])) {
    throw new Error('SKILL.md must start with YAML frontmatter delimited by `---`');
  }
  i++; // consume opening `---`

  const frontmatterLines: string[] = [];
  while (i < lines.length && !DELIMITER.test(lines[i])) {
    frontmatterLines.push(lines[i]);
    i++;
  }
  if (i >= lines.length) {
    throw new Error('SKILL.md frontmatter not terminated by closing `---`');
  }
  i++; // consume closing `---`

  const body = lines.slice(i).join('\n');
  const frontmatter = parseMiniYaml(frontmatterLines);
  return { frontmatter, body };
}

// ────────────────────────────────────────────────────────────────────────
// Mini YAML parser — supports the subset SKILL.md actually uses.
//
// Supported:
//   - key: scalar               → string (quoted or not), number, boolean
//   - key: [a, b, c]            → flow array (scalars only)
//   - key:                      → nested map (indented children)
//       child: value
//   - `#` comments on any line (stripped)
//
// NOT supported (throws or falls back to raw string):
//   - block arrays (`- item`)
//   - `>` / `|` folded/literal blocks
//   - anchors / aliases
//   - multi-document streams
// ────────────────────────────────────────────────────────────────────────

function parseMiniYaml(lines: string[]): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  // Stack of open maps with their indent depth
  const stack: Array<{ map: Record<string, unknown>; indent: number }> = [
    { map: root, indent: -1 },
  ];

  for (const raw of lines) {
    const stripped = stripComment(raw);
    if (stripped.trim() === '') continue;

    const indent = leadingSpaces(stripped);
    const line = stripped.slice(indent);

    // Pop stack until we find a parent with lower indent
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].map;

    // Array items via `- ` at block level are not supported — treat as
    // a raw string under the previous key if we see it.
    if (line.startsWith('-')) {
      throw new Error('SKILL.md frontmatter: block arrays (-) not supported; use flow arrays [a, b]');
    }

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      throw new Error(`SKILL.md frontmatter: expected key: value, got "${line}"`);
    }
    const key = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();

    if (rest === '') {
      // Nested map: open a new child object
      const child: Record<string, unknown> = {};
      parent[key] = child;
      stack.push({ map: child, indent });
    } else {
      parent[key] = parseScalar(rest);
    }
  }

  return root;
}

function stripComment(line: string): string {
  // Only `#` preceded by whitespace counts as a comment — `#` inside
  // quotes or values (like version: 1.0#beta) would be mangled otherwise.
  let inString: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString) {
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line;
}

function leadingSpaces(s: string): number {
  let i = 0;
  while (i < s.length && s[i] === ' ') i++;
  return i;
}

function parseScalar(raw: string): unknown {
  const s = raw.trim();

  // Flow array
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (inner === '') return [];
    return splitFlowItems(inner).map(parseScalarItem);
  }

  return parseScalarItem(s);
}

function parseScalarItem(s: string): unknown {
  const t = s.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null' || t === '~') return null;

  // Quoted string
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }

  // Number
  if (/^-?\d+$/.test(t)) return Number.parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t)) return Number.parseFloat(t);

  return t;
}

/** Split `a, b, "c, d", [e, f]` on top-level commas only, respecting quotes
 *  and nested brackets. Used for flow arrays inside frontmatter. */
function splitFlowItems(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inString: '"' | "'" | null = null;
  let buf = '';
  for (const ch of s) {
    if (inString) {
      buf += ch;
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      buf += ch;
      continue;
    }
    if (ch === '[' || ch === '{') { depth++; buf += ch; continue; }
    if (ch === ']' || ch === '}') { depth--; buf += ch; continue; }
    if (ch === ',' && depth === 0) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim() !== '') out.push(buf);
  return out;
}
