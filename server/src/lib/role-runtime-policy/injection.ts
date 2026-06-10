function joinLines(lines: string[]): string {
  return lines.join('\n');
}

const CHIEF_OF_STAFF_CLAUSE_EN = joinLines([
  '',
  '[Chief of Staff 权限 — 由 workspace owner 预授权]',
  '- 你是本 workspace 的 Chief of Staff,已获得一次性预授权。',
  '- 对于 routine 任务(task.create / task.assign / task.start / task 状态流转),**不需要**逐个调用 prismer.approval.request_human_approval。',
  '- 仅在以下场景必须请人类审批:删除/不可逆操作、支出/账单、对外发布、policy 敏感动作。',
  '- 你仍受 maxAutonomousRounds=5 约束 — 5 轮 agent-to-agent dispatch 后必须停下要求继续授权。',
]);

const CHIEF_OF_STAFF_CLAUSE_ZH = joinLines([
  '',
  '[Chief of Staff 权限 — 由 workspace owner 预授权]',
  '- 你是本 workspace 的 Chief of Staff,已获得一次性预授权。',
  '- 对于 routine 任务(task.create / task.assign / task.start / task 状态流转),不需要逐个调用 prismer.approval.request_human_approval。',
  '- 仅在以下场景必须请人类审批:删除/不可逆操作、支出/账单、对外发布、policy 敏感动作。',
  '- 你仍受 maxAutonomousRounds=5 约束 — 5 轮 agent-to-agent dispatch 后必须停下要求继续授权。',
]);

const SKILL_FIRST_CLAUSE_ORCH_EN = joinLines([
  '[Skill-first — v2.0]',
  '- Before starting ANY task, call prismer.skill.installed to check for a matching skill. If matched, load and follow it.',
  '- Only fall back to a generic approach when no skill matches; avoid blind-writing code in an unexplored environment.',
  '- Office/file-output tasks (DOCX / PPTX / XLSX / PDF / CSV / Image / video) MUST use office-artifacts when applicable and real generation libraries — do NOT just rename an extension (e.g. saving markdown as .pdf). After generation, self-verify with `file <path>` or magic-bytes that the mimetype matches the claimed format.',
  '- After ONE failure, MUST re-check skills; do not retry the same generic approach.',
  '',
]);

const SKILL_FIRST_CLAUSE_SPEC_EN = joinLines([
  '[Skill-first — v2.0]',
  '- Before starting ANY task, call prismer.skill.installed to check for a matching skill. If matched, load and follow it.',
  '- Office/file-output tasks (DOCX / PPTX / XLSX / PDF / CSV / Image / video) MUST use office-artifacts when applicable and real generation libraries — do NOT just rename an extension. After generation, self-verify mimetype (`file <path>` or magic-bytes) matches the claimed format.',
  '',
]);

export function buildSkillFirstClause(isOrchestrator: boolean): string {
  return isOrchestrator ? SKILL_FIRST_CLAUSE_ORCH_EN : SKILL_FIRST_CLAUSE_SPEC_EN;
}

/**
 * v2.0 F1A — exported for agent-profiles.ts GET handler. The daemon
 * hermes/openclaw adapter reads /api/im/agent_profiles/:id (raw row.config),
 * NOT /api/im/agents/:id/spec — so the Skill-first dynamic injection must
 * also apply at the profile-DTO boundary.
 */
export function prependSkillFirstClauseIfMissing(base: unknown, isOrchestrator: boolean): unknown {
  const clause = buildSkillFirstClause(isOrchestrator);
  // v2.1 — accept either the legacy `[Skill-first` marker (v2.0 migrations
  // 422/423) OR the new contract's `[Skill and system capability routing]`
  // section (release 201 — profile-defaults + migration 425). Either form
  // already satisfies the discipline; injecting the clause on top would
  // duplicate guidance.
  const v20Marker = '[Skill-first';
  const v21Marker = '[Skill and system capability routing]';
  const hasSkillSection = (s: string): boolean => s.includes(v20Marker) || s.includes(v21Marker);
  const zhMarker = (s: string): boolean =>
    s.includes('技能优先') || s.includes('[Skill-first') || s.includes('[技能与系统能力路由]');
  if (base == null) {
    return { en: clause };
  }
  if (typeof base === 'string') {
    if (hasSkillSection(base)) return base;
    return clause + base;
  }
  if (typeof base === 'object' && !Array.isArray(base)) {
    const rec = base as Record<string, unknown>;
    const out: Record<string, unknown> = { ...rec };
    if (typeof rec.en === 'string' && !hasSkillSection(rec.en)) {
      out.en = clause + rec.en;
    }
    if (typeof rec.zh === 'string' && !zhMarker(rec.zh)) {
      // Zh-only fallback uses the same English clause so the agent still
      // has the principle visible. Bilingual profiles will already include
      // the zh version from migration 422/425 / use-simple-provisioning.ts.
      out.zh = clause + rec.zh;
    }
    return out;
  }
  return base;
}

/**
 * Append the Chief-of-Staff clause to operatingPrinciples in whatever shape it
 * arrives in: a plain string, an `{en, zh}` i18n object, or null/empty.
 *
 * Defensive about shape: if it's something unexpected (array / nested object),
 * we return the original verbatim — better to drop the clause than mangle the
 * downstream consumer.
 */
export function appendChiefOfStaffClause(base: unknown): unknown {
  if (base == null) {
    return { en: CHIEF_OF_STAFF_CLAUSE_EN.trimStart(), zh: CHIEF_OF_STAFF_CLAUSE_ZH.trimStart() };
  }
  if (typeof base === 'string') {
    return base + CHIEF_OF_STAFF_CLAUSE_EN;
  }
  if (typeof base === 'object' && !Array.isArray(base)) {
    const rec = base as Record<string, unknown>;
    const out: Record<string, unknown> = { ...rec };
    if (typeof rec.en === 'string') {
      out.en = rec.en + CHIEF_OF_STAFF_CLAUSE_EN;
    }
    if (typeof rec.zh === 'string') {
      out.zh = rec.zh + CHIEF_OF_STAFF_CLAUSE_ZH;
    }
    // If neither en nor zh existed as strings, fall back to adding en.
    if (typeof rec.en !== 'string' && typeof rec.zh !== 'string') {
      out.en = CHIEF_OF_STAFF_CLAUSE_EN.trimStart();
      out.zh = CHIEF_OF_STAFF_CLAUSE_ZH.trimStart();
    }
    return out;
  }
  return base;
}
