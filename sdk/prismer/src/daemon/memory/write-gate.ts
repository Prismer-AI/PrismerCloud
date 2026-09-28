// memory211/01 §3 轴H — 写入门 (write admission gates), the two gaps that were
// still open at W2 (spec axis H ①②③; ① placement_required already lived in
// `rpc.ts#handleWrite` from memory203/18 R6.3):
//
//   ② description_required — a NEW page must carry the mandated one-sentence
//      frontmatter self-summary. The extraction prompt and the memory skill both
//      promise it ("REQUIRED frontmatter … description"); the write path never
//      checked. The snippet/recall surface is fed from that description
//      (F1/F2), so a page without one is a recall-blind page.
//
//   ③ pkf_invalid — the HTML/PKF projection body must pass `validatePkf`
//      (structure level) BEFORE it lands. Cloud-side `normalizeWriteSource` has
//      enforced the same strict policy since §11.2 (`invalid_pkf`); the daemon
//      authoring surface accepted anything, so a body the cloud would refuse
//      could up-sync and only fail at materialization.
//
// Both gates are ADMISSION gates on the interactive agent authoring surface
// (`memory_write` RPC): the caller sees the 422 and can fix and retry. They are
// deliberately NOT applied to the automatic extraction pipeline — there the
// caller is a background leg that cannot repair anything, so a 422 would mean
// silently LOSING the memory (the D4 failure mode this realignment exists to
// kill). The pipeline keeps its deterministic repair/fallback behavior.

import { parsePkf, validatePkf, detectFormat } from '@prismer/pkf';

const FRONTMATTER_RE = /<script[^>]*type=["']application\/prismer\+json["'][^>]*>([\s\S]*?)<\/script>/i;

/**
 * The frontmatter `description` of a PKF body, or null when the body carries no
 * frontmatter script or an empty/non-string description.
 */
export function extractPkfFrontmatterDescription(content: string): string | null {
  const match = content.match(FRONTMATTER_RE);
  if (!match?.[1]) return null;
  try {
    const value = JSON.parse(match[1]) as { description?: unknown };
    return typeof value.description === 'string' && value.description.trim()
      ? value.description.trim()
      : null;
  } catch {
    return null;
  }
}

/**
 * ② — a NEW page on the authoring surface must carry a description. Only PKF /
 * HTML projection bodies are gated: markdown is the legacy compatibility input
 * (normalized cloud-side) and has no frontmatter to check, so rejecting it
 * would close the documented legacy door instead of enforcing the contract.
 */
export function checkDescriptionGate(content: string): { code: 'description_required'; message: string } | null {
  if (detectFormat(content) !== 'pkf') return null;
  if (extractPkfFrontmatterDescription(content)) return null;
  return {
    code: 'description_required',
    message:
      'A new memory page must carry a frontmatter description — the one-sentence self-summary recall ' +
      'surfaces read. Add <script type="application/prismer+json">{"type":"note","title":"…","description":"…",…}</script> ' +
      'as the first element of the body.',
  };
}

export interface PkfProjectionRejection {
  code: 'pkf_invalid';
  /** First structural error code from the validator (the actionable one). */
  detail: string;
  message: string;
}

/**
 * ③ — validate the HTML/PKF projection body at the STRUCTURE level. Warnings
 * never reject (untyped links, section layout hints); only hard structural
 * errors do (unknown rel, bad link scheme, duplicate anchors, budgets).
 * Markdown short-circuits (nothing to validate). Call AFTER the bare-asset-URI
 * upgrade so the taught `prismer://asset/<id>` authoring form has already been
 * rewritten into its v1.1-valid scoped form and cannot trip the strict-only
 * `bare-asset-uri` error.
 */
export function checkPkfProjection(content: string): PkfProjectionRejection | null {
  if (detectFormat(content) !== 'pkf') return null;
  let parsed;
  try {
    parsed = parsePkf(content);
  } catch (err) {
    return {
      code: 'pkf_invalid',
      detail: 'parse_failed',
      message: `Body is not parseable PKF: ${(err as Error).message}`,
    };
  }
  let result;
  try {
    result = validatePkf(parsed);
  } catch (err) {
    return {
      code: 'pkf_invalid',
      detail: 'validate_failed',
      message: `PKF validation threw: ${(err as Error).message}`,
    };
  }
  if (result.structureStatus === 'pass') return null;
  const first = result.diagnostics.find((d) => d.level === 'error');
  return {
    code: 'pkf_invalid',
    detail: first?.code ?? 'structure_fail',
    message: `Body failed PKF structure validation (${first?.code ?? 'structure_fail'}): ${
      first?.message ?? 'see pkf_validate diagnostics'
    }.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// memory211/10 R1 §2.1 — evolution-artifact metadata gate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The controlled value domain of `memoryRole` (07 §2.1), in canonical order.
 *
 * MIRROR of `MEMORY_ROLES` in `src/im/services/memory-activation-probe.ts`. The
 * two cannot share code (separate package / tsconfig / staged pkf copy), so the
 * equality is enforced instead of assumed:
 * `scripts/__tests__/memory211-evolution-metadata-parity.test.ts` asserts both
 * the domain AND verdict-for-verdict behaviour against a shared fixture table.
 * Change one side without the other and that suite goes red.
 */
export const MEMORY_ROLES = ['knowledge', 'procedure', 'action_result'] as const;

/** Controlled key set of `extra.memory`; unknown keys are rejected so the domain
 *  cannot widen by accident (07 §2.1 「受控 frontmatter 块…未知键拒绝」). */
const EVOLUTION_BLOCK_KEYS = new Set(['memoryRole', 'source', 'trigger', 'validation', 'sections']);

/** D-1 (a) — per-section entries are indexed by `anchor`. */
const EVOLUTION_SECTION_KEYS = new Set(['anchor', 'memoryRole', 'source', 'trigger', 'validation']);

export interface EvolutionMetadataRejection {
  code: 'evolution_metadata_required';
  /** Names the offending field, so the writer gets an actionable fix. */
  detail: string;
  message: string;
}

function rejection(detail: string): EvolutionMetadataRejection {
  return {
    code: 'evolution_metadata_required',
    detail,
    message:
      `An evolution artifact must declare its semantic role and provenance in the PKF frontmatter ` +
      `(07 §2.1) — write a top-level \`memory\` key; read back as \`extra.memory\`: ${detail}.`,
  };
}

/** The stored `extra.memory` block of a PKF body; null when absent / unreadable. */
function evolutionBlockOf(content: string): Record<string, unknown> | null {
  if (detectFormat(content) !== 'pkf') return null;
  try {
    const parsed = parsePkf(content);
    const extra = parsed.frontmatter?.extra as Record<string, unknown> | undefined;
    const block = extra?.memory;
    if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
    return block as Record<string, unknown>;
  } catch {
    return null;
  }
}

function checkRoleAndSource(meta: Record<string, unknown>, where: string): string | null {
  const role = meta.memoryRole;
  if (typeof role !== 'string' || !(MEMORY_ROLES as readonly string[]).includes(role))
    return `${where}.memoryRole must be one of ${MEMORY_ROLES.join(' | ')}`;
  if (typeof meta.source !== 'string' || !meta.source.trim())
    return `${where}.source must be a non-empty provenance string`;
  return null;
}

function checkTrigger(raw: unknown, where: string): string | null {
  if (raw === undefined) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return `${where}.trigger must be an object`;
  const t = raw as Record<string, unknown>;
  if (typeof t.event !== 'string' || !t.event.trim()) return `${where}.trigger.event is required`;
  if (typeof t.state !== 'string') return `${where}.trigger.state must be a string`;
  return null;
}

/**
 * §2.1 admission check for an evolution artifact's page body. Returns the
 * rejection, or null when the `extra.memory` block satisfies the controlled
 * domain.
 *
 * Admission semantics (same as the sibling gates above): the caller is an
 * interactive surface that can show the 422 and let the author repair and retry.
 * It is deliberately NOT applied on the automatic extraction leg — see the file
 * header — and it is NOT wired to a call site yet; the daemon's evolution
 * surface is the `memory.proposal` outbox lane, which R2 wires once candidates
 * actually carry the block.
 */
export function checkEvolutionMetadataGate(content: string): EvolutionMetadataRejection | null {
  const block = evolutionBlockOf(content);
  // Name the AUTHORING form, not the internal path — see the twin comment in
  // `src/im/services/memory-activation-probe.ts` (a writer told "missing
  // extra.memory" emits `{"extra":{"memory":{…}}}`, which the parser routes to
  // `extra.extra.memory` and this gate rejects again). The key to WRITE is a
  // top-level `memory`.
  if (!block) return rejection('the PKF frontmatter script carries no top-level `memory` key (read back as `extra.memory`)');

  const unknown = Object.keys(block).filter((k) => !EVOLUTION_BLOCK_KEYS.has(k));
  if (unknown.length) return rejection(`unknown key(s) in extra.memory: ${unknown.join(', ')}`);

  const own = checkRoleAndSource(block, 'extra.memory');
  if (own) return rejection(own);
  const trigger = checkTrigger(block.trigger, 'extra.memory');
  if (trigger) return rejection(trigger);

  const sections = block.sections;
  if (sections === undefined) return null;
  if (!Array.isArray(sections)) return rejection('extra.memory.sections must be an array');
  for (let i = 0; i < sections.length; i++) {
    const where = `extra.memory.sections[${i}]`;
    const entry = sections[i];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return rejection(`${where} must be an object`);
    const rec = entry as Record<string, unknown>;
    const bad = Object.keys(rec).filter((k) => !EVOLUTION_SECTION_KEYS.has(k));
    if (bad.length) return rejection(`unknown key(s) in ${where}: ${bad.join(', ')}`);
    // Indexed by anchor (D-1 (a)). Same scope as the cloud twin: a non-empty
    // string is required, existence among the page's real sections is NOT
    // checked here (the gate sees only the body).
    if (typeof rec.anchor !== 'string' || !rec.anchor.trim()) return rejection(`${where}.anchor is required`);
    const sectionOwn = checkRoleAndSource(rec, where);
    if (sectionOwn) return rejection(sectionOwn);
    const sectionTrigger = checkTrigger(rec.trigger, where);
    if (sectionTrigger) return rejection(sectionTrigger);
  }
  return null;
}
