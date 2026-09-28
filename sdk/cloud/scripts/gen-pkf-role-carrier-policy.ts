/**
 * Removes historical role-local PKF/Markdown carrier overrides.
 *
 * Carrier policy is injected once by Runtime's PKF_REPORT_DIRECTIVE. Role
 * templates may define business deliverables, but must not select a PKF
 * carrier. Running this generator keeps the catalog free of the legacy policy.
 *
 *   npx tsx sdk/cloud/scripts/gen-pkf-role-carrier-policy.ts
 *   CHECK=1 npx tsx sdk/cloud/scripts/gen-pkf-role-carrier-policy.ts
 *   TAMPER=1 CHECK=1 npx tsx sdk/cloud/scripts/gen-pkf-role-carrier-policy.ts
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROLE_DIRS = [
  { label: 'catalog', dir: path.resolve(SCRIPT_DIR, '../catalog/roles') },
  { label: 'runtime-fallback', dir: path.resolve(SCRIPT_DIR, '../../prismer/src/templates/roles') },
] as const;
const CHECK = process.env.CHECK === '1';
const TAMPER = process.env.TAMPER === '1';

const LEGACY_ROLE_POLICY =
  '\n\nMemory and reports: treat long-term memory as a standing duty (recall via `memory_search` first, write browse-first via `memory_write`), and deliver complex structured reports — at least one table, two or more section headings, or a data-visualization need — as a PKF memory page plus a parallel markdown projection per the `pkf-writing` skill (with `pkf_validate` before persisting); if a valid PKF page cannot be produced, output plain markdown instead of blocking the answer.';

const LEGACY_MARKDOWN_POLICY =
  '\n\nDelivery contract (documentation-type deliverables = markdown files): reports MUST be markdown files landed into ${PRISMER_ARTIFACTS_DIR}/. The daemon artifacts-watcher registers them as task-bound assets — that IS the deliverable. Group-chat replies are summaries/teasers; do not paste long reports into the conversation.';

const CARRIER_BOUNDARY =
  '[Carrier boundary] Carrier selection is owned by the Runtime directive and the selected content skill. This role never changes an inline PKF into a file/Asset/Memory Page or creates parallel Markdown/HTML/CSS/JS artifacts unless the user explicitly requests those files.';
const CARRIER_BOUNDARY_ZH =
  '[Carrier 边界] carrier 由 Runtime 指令和所选内容 skill 单点决定。本 role 不得把 inline PKF 改成文件、Asset 或 Memory Page，也不得并行生成 Markdown/HTML/CSS/JS 产物，除非用户明确要求这些文件。';

const FORBIDDEN = [
  /PKF memory page plus a parallel markdown projection/i,
  /complex structured reports[\s\S]*Memory Page/i,
  /documentation-type deliverables\s*=\s*markdown files/i,
  /文档型交付物\s*=\s*markdown 文件/i,
  /MUST be (?:a )?markdown files?/i,
  /必须写成 markdown 文件/i,
  /task-bound markdown artifacts?/i,
  /artifacts-watcher 自动注册/i,
  /artifacts-watcher receipt is the authoritative delivery receipt/i,
  /写成 markdown 落到/i,
  /markdown 验收记录走 artifacts\/ 自动归档/i,
  /\(as markdown\)/i,
  /（以 markdown 呈现）/i,
];

function rewriteCarrierPolicy(value: string): string {
  return value
    .replace(/\s*\(as markdown\)/gi, '')
    .replace(/（以 markdown 呈现）/g, '')
    .replace(
      /文档型交付物 = markdown 文件：完整验收记录写成 markdown 落到 \$\{PRISMER_ARTIFACTS_DIR\}\/[^\n]*/g,
      '完整验收记录遵循 Runtime carrier 指令和所选内容 skill；仅当用户明确要求文件时才写入 ${PRISMER_ARTIFACTS_DIR}/ 并显式 `cloud deliver` / `cloud task attach`。二进制证据仍走 `cloud task attach`；`--note` 只放 summary，不贴整篇记录。详见 tasks skill SKILL.md §Carrier 选择与显式交付。',
    )
    .replace(
      /Delivery contract \(documentation-type deliverables = markdown files\):/g,
      'Delivery contract (carrier selection is Runtime-owned):',
    )
    .replace(
      /MUST be (?:a )?markdown files? landed into \$\{PRISMER_ARTIFACTS_DIR\}\//g,
      'MUST follow the user-requested carrier and selected content skill; write files into ${PRISMER_ARTIFACTS_DIR}/ only when the user explicitly requests a file deliverable',
    )
    .replace(
      /write user-facing delivery notes \/ implementation reports as markdown files into \$\{PRISMER_ARTIFACTS_DIR\}\//g,
      'make user-facing delivery notes / implementation reports follow the user-requested carrier and selected content skill; write them into ${PRISMER_ARTIFACTS_DIR}/ only when the user explicitly requests files',
    )
    .replace(
      /The daemon artifacts-watcher registers (?:them|it) as (?:a )?task-bound assets?(?: attached to this reply)? — that IS the deliverable\./g,
      'For an explicitly requested file, the receipt returned by `cloud deliver` / `cloud task attach` is the authoritative delivery receipt.',
    )
    .replace(
      /For an explicitly requested file, the daemon artifacts-watcher receipt is the authoritative delivery receipt\./g,
      'For an explicitly requested file, the receipt returned by `cloud deliver` / `cloud task attach` is the authoritative delivery receipt.',
    )
    .replace(
      /Group-chat replies are (?:only )?(?:a one-line )?summar(?:y|ies)\/teasers?; do not paste [^.]+ into the conversation\./g,
      'Follow the Runtime carrier directive for chat delivery; for an explicitly requested file, keep the chat reply concise and link its receipt.',
    )
    .replace(/task-bound markdown artifacts?/gi, 'task-bound artifacts in the user-requested carrier')
    .replace(
      /You keep chat replies short and let the artifacts be the deliverable\./g,
      'You follow the Runtime carrier directive and treat only the authoritative carrier receipt as delivery.',
    )
    .replace(/交付约定（文档型交付物 = markdown 文件）：/g, '交付约定（carrier 选择由 Runtime 单点控制）：')
    .replace(
      /必须写成 markdown 文件[，,]?\s*落到 \$\{PRISMER_ARTIFACTS_DIR\}\//g,
      '必须遵循用户请求和所选内容 skill 的 carrier；仅当用户明确要求文件时才写入 ${PRISMER_ARTIFACTS_DIR}/',
    )
    .replace(
      /写成 markdown 文件[，,]?\s*落到 \$\{PRISMER_ARTIFACTS_DIR\}\//g,
      '遵循用户请求和所选内容 skill 的 carrier；仅当用户明确要求文件时才写入 ${PRISMER_ARTIFACTS_DIR}/',
    )
    .replace(
      /面向用户的交付说明 \/ 实现报告 \/ 变更记录写成 markdown 文件[，,]?\s*落到 \$\{PRISMER_ARTIFACTS_DIR\}\//g,
      '面向用户的交付说明 / 实现报告 / 变更记录遵循用户请求和所选内容 skill 的 carrier；仅当用户明确要求文件时才写入 ${PRISMER_ARTIFACTS_DIR}/',
    )
    .replace(
      /daemon artifacts-watcher 自动注册成任务绑定资产并挂到本次回复 —— 这就是交付物本体。/g,
      '用户明确要求文件时，显式 `cloud deliver` / `cloud task attach` 返回的回执才是该文件的权威交付回执。',
    )
    .replace(
      /daemon artifacts-watcher 自动注册成 task-bound 资产并挂到本次回复 —— 这就是交付物本体。/g,
      '用户明确要求文件时，显式 `cloud deliver` / `cloud task attach` 返回的回执才是该文件的权威交付回执。',
    )
    .replace(
      /daemon artifacts-watcher 自动注册成 task-bound 资产 —— 这就是交付物本体。/g,
      '用户明确要求文件时，显式 `cloud deliver` / `cloud task attach` 返回的回执才是该文件的权威交付回执。',
    )
    .replace(
      /用户明确要求文件时，daemon artifacts-watcher 的回执才是该文件的权威交付回执。/g,
      '用户明确要求文件时，显式 `cloud deliver` / `cloud task attach` 返回的回执才是该文件的权威交付回执。',
    )
    .replace(
      /daemon artifacts-watcher 自动注册成 task-bound 资产[^。\n]*。/g,
      '用户明确要求文件时，显式 `cloud deliver` / `cloud task attach` 返回的回执才是该文件的权威交付回执。',
    )
    .replace(
      /群聊回复(?:只)?是\s*(?:一句话点出结论的 )?summary\/teaser，不要把[^。]+。/g,
      '聊天交付遵循 Runtime carrier 指令；用户明确要求文件时，群聊只需简述并链接权威回执。',
    )
    .replace(
      /群聊回复只是 summary\/teaser（一句话点出结论），不要把整篇备忘录贴进对话。/g,
      '聊天交付遵循 Runtime carrier 指令；用户明确要求文件时，群聊只需简述并链接权威回执。',
    )
    .replace(/任务绑定 markdown 产物/g, '遵循用户所选 carrier 的任务绑定产物')
    .replace(/以遵循用户所选 carrier 的任务绑定产物/g, '以用户所选 carrier 的任务绑定产物')
    .replace(/after uploading deliverables as workspace files/g, 'after delivery through the authoritative carrier')
    .replace(/把代码上传为 workspace file 后/g, '把代码按工程惯例落盘后')
    .replace(/§文档型交付物/g, '§Carrier 选择与显式交付')
    .replace(
      /把评审记录也写成 markdown 落到 artifacts\//g,
      '评审记录遵循 Runtime carrier 指令；仅当用户明确要求文件时才写入 artifacts/',
    )
    .replace(
      /markdown 验收记录走 artifacts\/ 自动归档/g,
      '验收记录遵循 Runtime carrier 指令；用户明确要求文件时通过显式 attach 交付',
    );
}

function rewriteObject(value: unknown): unknown {
  if (typeof value === 'string') return rewriteCarrierPolicy(value);
  if (Array.isArray(value)) return value.map(rewriteObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, rewriteObject(child)]),
  );
}

const files = ROLE_DIRS.flatMap(({ label, dir }) =>
  readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => ({ label, dir, name })),
);

let changed = 0;
const errors: string[] = [];

for (const [index, file] of files.entries()) {
  const target = path.join(file.dir, file.name);
  const original = JSON.parse(readFileSync(target, 'utf8')) as {
    operatingPrinciples?: unknown;
    metadata?: { operatingPrinciplesI18n?: { zh?: unknown } };
    configSchema?: { systemPrompt?: unknown };
  };
  const originalText = JSON.stringify(original);
  const hadLegacyMarkdown = /documentation-type deliverables\s*=\s*markdown files/i.test(originalText) ||
    /文档型交付物\s*=\s*markdown 文件/i.test(originalText);
  const parsed = rewriteObject(original) as typeof original;
  if (typeof parsed.operatingPrinciples === 'string') {
    parsed.operatingPrinciples = parsed.operatingPrinciples.replace(LEGACY_ROLE_POLICY, '');
    if (hadLegacyMarkdown && !parsed.operatingPrinciples.includes(CARRIER_BOUNDARY)) {
      parsed.operatingPrinciples = `${parsed.operatingPrinciples}\n\n${CARRIER_BOUNDARY}`;
    }
  }
  const zh = parsed.metadata?.operatingPrinciplesI18n?.zh;
  if (hadLegacyMarkdown && typeof zh === 'string' && !zh.includes(CARRIER_BOUNDARY_ZH)) {
    parsed.metadata!.operatingPrinciplesI18n!.zh = `${zh}\n\n${CARRIER_BOUNDARY_ZH}`;
  }
  const runtimePrompt = parsed.configSchema?.systemPrompt;
  if (hadLegacyMarkdown && typeof runtimePrompt === 'string' && !runtimePrompt.includes(CARRIER_BOUNDARY_ZH)) {
    parsed.configSchema!.systemPrompt = `${runtimePrompt}\n\n${CARRIER_BOUNDARY_ZH}`;
  }
  if (TAMPER && index === 0) {
    parsed.operatingPrinciples = `${String(parsed.operatingPrinciples ?? '')}${LEGACY_ROLE_POLICY}${LEGACY_MARKDOWN_POLICY}`;
  }

  const rendered = `${JSON.stringify(parsed, null, 2)}\n`;
  for (const forbidden of FORBIDDEN) {
    if (forbidden.test(rendered)) errors.push(`${file.label}/${file.name}: role-local carrier override`);
  }

  const current = readFileSync(target, 'utf8');
  if (rendered !== current) {
    changed += 1;
    if (!CHECK && !TAMPER) writeFileSync(target, rendered, 'utf8');
  }
}

if (errors.length > 0) {
  console.error('[gen-pkf-role-carrier-policy] ❌ carrier policy gate red:');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

if (CHECK && changed > 0) {
  console.error(`[gen-pkf-role-carrier-policy] ❌ ${changed} role file(s) differ from the generated policy boundary`);
  process.exit(1);
}

console.log(`[gen-pkf-role-carrier-policy] ✅ ${files.length} role file(s), changed=${changed}`);
