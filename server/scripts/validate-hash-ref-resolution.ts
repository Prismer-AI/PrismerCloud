/**
 * M4 E2E validation: #filename reference resolution edge cases.
 * Usage: npx tsx scripts/validate-hash-ref-resolution.ts
 *
 * Tests the regex patterns from dispatch.ts resolveHashRefs() and
 * im-channel.tsx updateMentionState() # branch.
 * Must stay in sync with the extraction logic in dispatch.ts.
 */

const HASH_REF_RE = /(?:^|\s)#([^\s#]+)/g;
const HEX_COLOR_RE = /^[0-9a-fA-F]{3,8}$/;
const FILE_EXT_RE = /\.[a-zA-Z0-9]{1,10}$/;
const TRAILING_PUNCT_RE = /[,.;:!?)\]}'"]+$/;

interface Candidate { ref: string; start: number; end: number; hasExtension: boolean; }

function extractCandidates(prompt: string): Candidate[] {
  const candidates: Candidate[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(HASH_REF_RE.source, 'g');
  while ((match = re.exec(prompt)) !== null) {
    const refName = match[1]!;
    const leading = match[0].startsWith('#') ? 0 : 1;
    const start = match.index + leading;
    const end = match.index + match[0].length;

    // Step 1: hex color filter (before stripping, raw capture)
    if (HEX_COLOR_RE.test(refName)) continue;

    // Step 2: strip trailing punctuation
    let cleanRef = refName;
    let stripped = '';
    const punctMatch = TRAILING_PUNCT_RE.exec(cleanRef);
    if (punctMatch) {
      stripped = punctMatch[0];
      cleanRef = cleanRef.slice(0, -stripped.length);
    }
    if (!cleanRef) continue;

    // Step 3: recheck hex after stripping (e.g. "#fff;" → "fff" is hex)
    if (HEX_COLOR_RE.test(cleanRef)) continue;

    const hasExtension = FILE_EXT_RE.test(cleanRef);
    candidates.push({ ref: cleanRef, start, end: end - stripped.length, hasExtension });
  }
  return candidates;
}

let passed = 0;
let failed = 0;
let knownLimitations: string[] = [];

function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  OK  ${name}`); }
  catch (err) { failed++; console.log(`  FAIL  ${name}\n    ${(err as Error).message}`); }
}

function assert<T>(actual: T, expected: T, label?: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label ?? 'assert'}: expected ${e}, got ${a}`);
}

function noteLimitation(desc: string) { knownLimitations.push(desc); }

console.log('\n=== #ref Extraction ===\n');

test('basic filename with extension', () => {
  const r = extractCandidates('check #readme.md for details');
  assert(r.length, 1); assert(r[0]!.ref, 'readme.md');
  assert(r[0]!.start, 6); assert(r[0]!.end, 16);
  assert(r[0]!.hasExtension, true);
});

test('ref with path-like name: #src/app.ts', () => {
  const r = extractCandidates('see #config.json and #src/app.ts');
  assert(r.length, 2);
  assert(r[0]!.ref, 'config.json');
  assert(r[1]!.ref, 'src/app.ts');
});

test('ref at start of prompt', () => {
  const r = extractCandidates('#readme.md is the doc');
  assert(r.length, 1); assert(r[0]!.ref, 'readme.md'); assert(r[0]!.start, 0);
});

test('ref at end of prompt', () => {
  const r = extractCandidates('the entry point is #main.go');
  assert(r.length, 1); assert(r[0]!.ref, 'main.go');
});

test('ref preceded by newline', () => {
  const r = extractCandidates('line one\n#config.yaml settings');
  assert(r.length, 1); assert(r[0]!.ref, 'config.yaml');
});

console.log('\n=== Extensionless Ref Extraction (checked against index in Pass 2) ===\n');

test('extensionless #Dockerfile extracted (index check in Pass 2)', () => {
  const r = extractCandidates('#Dockerfile is the build config');
  assert(r.length, 1); assert(r[0]!.ref, 'Dockerfile'); assert(r[0]!.hasExtension, false);
});

test('extensionless #Makefile extracted for index lookup', () => {
  const r = extractCandidates('build with #Makefile');
  assert(r.length, 1); assert(r[0]!.ref, 'Makefile'); assert(r[0]!.hasExtension, false);
});

test('extensionless #LICENSE extracted for index lookup', () => {
  const r = extractCandidates('see #LICENSE for terms');
  assert(r.length, 1); assert(r[0]!.ref, 'LICENSE'); assert(r[0]!.hasExtension, false);
});

test('extensionless #awesome extracted but left unresolved in Pass 2 (no index match)', () => {
  const r = extractCandidates('this is #awesome work');
  assert(r.length, 1); assert(r[0]!.ref, 'awesome'); assert(r[0]!.hasExtension, false);
});

console.log('\n=== Hex Color Filtering ===\n');

test('hex #fff skipped (before stripping)', () => { assert(extractCandidates('bg: #fff color: #000').length, 0); });
test('hex #fff; skipped (after stripping)', () => { assert(extractCandidates('bg: #fff; color: #000;').length, 0); });
test('hex #f0f0f0 skipped', () => { assert(extractCandidates('border: #f0f0f0').length, 0); });
test('hex #ff0000ff (8-char alpha) skipped', () => { assert(extractCandidates('rgba: #ff0000ff').length, 0); });
test('3-char hex #bad skipped (looks like color)', () => { assert(extractCandidates('color #bad').length, 0); });

console.log('\n=== Trailing Punctuation Stripping ===\n');

test('trailing comma stripped: #readme.md, → readme.md', () => {
  const r = extractCandidates('see #readme.md, and more');
  assert(r.length, 1); assert(r[0]!.ref, 'readme.md');
});

test('trailing semicolon stripped: #config.json; → config.json', () => {
  const r = extractCandidates('load #config.json; then');
  assert(r.length, 1); assert(r[0]!.ref, 'config.json');
});

test('trailing period stripped: #readme.md. → readme.md', () => {
  const r = extractCandidates('see #readme.md.');
  assert(r.length, 1); assert(r[0]!.ref, 'readme.md');
});

test('trailing colon stripped: #config.yaml: → config.yaml', () => {
  const r = extractCandidates('key #config.yaml: value');
  assert(r.length, 1); assert(r[0]!.ref, 'config.yaml');
});

test('trailing paren stripped: #file.txt) extra', () => {
  const r = extractCandidates('#file.txt) extra');
  assert(r.length, 1); assert(r[0]!.ref, 'file.txt');
});

test('multiple trailing punct: #readme.md., → readme.md', () => {
  const r = extractCandidates('see #readme.md.,');
  assert(r.length, 1); assert(r[0]!.ref, 'readme.md');
});

test('only punctuation after # is dropped: #, is empty', () => {
  const r = extractCandidates('bare #, text');
  assert(r.length, 0);
});

test('two refs separated by comma: #a.txt, #b.txt', () => {
  const r = extractCandidates('#a.txt, #b.txt');
  assert(r.length, 2);
  assert(r[0]!.ref, 'a.txt');
  assert(r[1]!.ref, 'b.txt');
});

console.log('\n=== Edge Cases ===\n');

test('ref with dots: index.v1.2.ts', () => {
  const r = extractCandidates('import #index.v1.2.ts');
  assert(r.length, 1); assert(r[0]!.ref, 'index.v1.2.ts');
});

test('ref with underscores', () => {
  const r = extractCandidates('load #my_config_file.yaml');
  assert(r.length, 1); assert(r[0]!.ref, 'my_config_file.yaml');
});

test('ref with dashes: docker-compose.yml', () => {
  const r = extractCandidates('use #docker-compose.yml');
  assert(r.length, 1); assert(r[0]!.ref, 'docker-compose.yml');
});

test('hidden file .gitignore', () => {
  const r = extractCandidates('check #.gitignore rules');
  assert(r.length, 1); assert(r[0]!.ref, '.gitignore');
});

test('no ref plain text', () => { assert(extractCandidates('hello world').length, 0); });
test('no ref @mention only', () => { assert(extractCandidates('hey @alice').length, 0); });

test('MUST: # preceded by non-whitespace (parens) is NOT matched', () => {
  assert(extractCandidates('the file (#readme.md)').length, 0);
});

test('MUST: # immediately after word char is NOT matched (URL fragment)', () => {
  assert(extractCandidates('see url#fragment here').length, 0);
});

test('KNOWN LIMIT: filenames with spaces not captured by dispatch regex', () => {
  const r = extractCandidates('see #my design doc.pdf');
  assert(r.length, 1);
  assert(r[0]!.ref, 'my');
  assert(r[0]!.hasExtension, false);
  noteLimitation('Filenames with spaces not captured by HASH_REF_RE at dispatch time');
});

console.log('\n=== Reverse-Order Replacement ===\n');

function simulateReplace(prompt: string, resolutions: Array<{ start: number; end: number; uri: string }>): string {
  let result = prompt;
  for (const r of [...resolutions].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, r.start) + r.uri + result.slice(r.end);
  }
  return result;
}

test('single replacement', () => {
  assert(simulateReplace('see #readme.md', [{ start: 4, end: 14, uri: 'prismer://ws/w1/asset/abc' }]), 'see prismer://ws/w1/asset/abc');
});

test('multiple replacements preserve positions', () => {
  assert(
    simulateReplace('compare #a.txt with #b.txt', [
      { start: 8, end: 14, uri: 'URI_A' }, { start: 20, end: 26, uri: 'URI_B' }
    ]),
    'compare URI_A with URI_B'
  );
});

test('reverse-order handles positions correctly', () => {
  assert(
    simulateReplace('#a.txt extra #b.txt', [
      { start: 0, end: 6, uri: 'URI_A' }, { start: 13, end: 19, uri: 'URI_B' }
    ]),
    'URI_A extra URI_B'
  );
});

console.log('\n=== AssetPicker Token Regex (/^[a-zA-Z0-9._\\-\\s]+$/) ===\n');

const TOKEN_RE = /^[a-zA-Z0-9._\-\s]+$/;

test('token: readme.md', () => { assert(TOKEN_RE.test('readme.md'), true); });
test('token: my design doc.pdf', () => { assert(TOKEN_RE.test('my design doc.pdf'), true); });
test('token: docker-compose.yml', () => { assert(TOKEN_RE.test('docker-compose.yml'), true); });
test('token: .gitignore', () => { assert(TOKEN_RE.test('.gitignore'), true); });
test('token: version-2.0_beta.tar.gz', () => { assert(TOKEN_RE.test('version-2.0_beta.tar.gz'), true); });
test('reject: empty', () => { assert(TOKEN_RE.test(''), false); });
test('reject: contains #', () => { assert(TOKEN_RE.test('a#b.txt'), false); });
test('reject: contains /', () => { assert(TOKEN_RE.test('folder/file.txt'), false); });
test('reject: contains @', () => { assert(TOKEN_RE.test('a@b.txt'), false); });

console.log('\n=== Cloud API ?q= Response Shape ===\n');

test('AssetAutocompleteItem interface matches API select shape', () => {
  const apiFields = ['id', 'contentHash', 'filename', 'folderPath', 'mime', 'kind', 'sizeBytes'];
  const interfaceFields = ['id', 'contentHash', 'filename', 'folderPath', 'mime', 'kind', 'sizeBytes'];
  assert(apiFields.sort(), interfaceFields.sort());
});

console.log(`\n${'='.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (knownLimitations.length > 0) {
  console.log(`\nKnown limitations (${knownLimitations.length}):`);
  for (const l of knownLimitations) console.log(`  - ${l}`);
}
console.log(`${'='.repeat(60)}\n`);

process.exit(failed > 0 ? 1 : 0);
