/**
 * Agent file-claim detector — release201/30 §8 (warn-only telemetry).
 *
 * Extracted verbatim from ws/handler.ts so the patterns are unit-testable
 * WITHOUT importing the whole WS handler (which pulls in k8s/dispatch deps).
 * Behaviour is identical — handler.ts now imports from here.
 *
 * NOTE (release201/30 §8): these patterns are telemetry-only. A
 * `claimedFile && !hasRealAsset` disagreement logs `log.warn` for SRE
 * traceability but does NOT write `metadata.systemFlags=['lie_intercepted']`
 * and does NOT flip dispatch lifecycle to 'failed' (that 2026-05-29 stance,
 * doc 21 §3.1, is DEPRECATED). Agent replies always run 'completed'.
 */

const FILE_FORMAT = '(?:\\.(?:pdf|docx|pptx|xlsx|csv|html|md|zip)|\\b(?:PDF|DOCX|PPTX|XLSX|CSV|HTML|MD|ZIP)\\b)';
const VERB_VERB = '(?:生成|做好|完成|输出|落盘|附件|上传|交付|准备好|搞定|做完|写完|建好)';

export const LIE_PATTERNS: readonly RegExp[] = [
  new RegExp(`(?:已经?|已)${VERB_VERB}.{0,60}${FILE_FORMAT}`, 'i'),
  new RegExp(`${FILE_FORMAT}.{0,30}(?:已经?|已)${VERB_VERB}`, 'i'),
  /(?:已|已经)?(?:作为)?附件(?:发送|给你|提供|交付)/,
  /(?:已|已经)?上传(?:到|至)\s*\S+/,
  /\bPDF\b\s*(?:文件|文档|资料)?\s*已\s*\d+\s*(?:页|MB|KB)/i,
  /\b[Cc]reated\s+(?:the|a|an)?\s*[\w.-]*\.(pdf|docx|pptx|xlsx|csv|html|md|zip)/,
  /\b[Aa]ttached\s+(?:the|a|an)?\s*(file|document|pdf|report|deck|slides|spreadsheet)/,
  /\b[Gg]enerated\s+(?:the|a|an)?\s*[\w.-]*\.(pdf|docx|pptx|xlsx|csv|html|md|zip)/,
];

export function detectAgentFileClaim(text: string): boolean {
  if (!text || text.length < 4) return false;
  return LIE_PATTERNS.some((re) => re.test(text));
}
