// Brand voice guard — extracted from cli/ui.ts so that installer (shell),
// SDK library, and runtime CLI can all run the same check.
//
// Activated only when PRISMER_BRAND_VOICE_STRICT is set (test/CI contexts);
// default production paths do not pay the regex cost.

const FORBIDDEN_SUBSTRINGS = ['Sorry', 'Unfortunately', 'Oops'];
const FORBIDDEN_WORDS = ['Please'];

export function assertBrandVoice(text: string, label = 'text'): void {
  if (!process.env['PRISMER_BRAND_VOICE_STRICT']) return;
  for (const sub of FORBIDDEN_SUBSTRINGS) {
    if (text.includes(sub)) {
      throw new Error(`[Brand Voice] Forbidden substring "${sub}" in CLI ${label}: ${text}`);
    }
  }
  for (const word of FORBIDDEN_WORDS) {
    const re = new RegExp(`\\b${word}\\b`);
    if (re.test(text)) {
      throw new Error(`[Brand Voice] Forbidden word "${word}" in CLI ${label}: ${text}`);
    }
  }
  const lines = text.split('\n');
  for (const line of lines) {
    const stripped = line.replace(/"[^"]*"/g, '').replace(/'[^']*'/g, '');
    if (stripped.trimEnd().endsWith('!')) {
      throw new Error(`[Brand Voice] Trailing "!" in CLI ${label}: ${line}`);
    }
  }
}
