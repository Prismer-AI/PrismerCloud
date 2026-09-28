// Parse `claude --headless` stdout into TaskResult-friendly fields.
//
// 1.9.x m3 keeps this minimal: assemble assistant text content, surface stderr
// on failure. Structured tool-call extraction (e.g. for evolution signals)
// lands m4+.

export interface ParsedOutput {
  output: string;
  toolCalls: number;
  truncated: boolean;
}

const MAX_OUTPUT_CHARS = 64 * 1024;

/**
 * Naive concatenation strategy:
 *   - Lines that look like JSON status lines (`{"event":"…"}`) get the `text`
 *     field extracted if present, otherwise dropped.
 *   - All other lines kept verbatim.
 *   - Truncate at MAX_OUTPUT_CHARS to bound memory.
 */
export function parseHeadlessOutput(stdout: string): ParsedOutput {
  let out = '';
  let toolCalls = 0;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const obj = JSON.parse(trimmed) as { event?: string; text?: string; tool?: string };
        if (obj.event === 'tool_call' || obj.tool) {
          toolCalls += 1;
          continue;
        }
        if (typeof obj.text === 'string') {
          out += obj.text;
          continue;
        }
      } catch {
        // Not JSON despite shape, fall through.
      }
    }
    out += line + '\n';
  }
  const truncated = out.length > MAX_OUTPUT_CHARS;
  if (truncated) out = out.slice(0, MAX_OUTPUT_CHARS) + '\n…[truncated]';
  return { output: out.trim(), toolCalls, truncated };
}
