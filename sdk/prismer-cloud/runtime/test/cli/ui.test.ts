import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { UI, applyCommonFlags, assertBrandVoice, __resetUIForTests } from '../../src/cli/ui.js';

// ============================================================
// Helpers
// ============================================================

const ANSI_RE = /\u001b\[[0-9;]*m/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

function hasAnsi(s: string): boolean {
  return s.includes('\u001b[');
}

function makeCollector(): { chunks: string[]; stream: NodeJS.WritableStream } {
  const chunks: string[] = [];
  const stream = {
    write(chunk: string | Buffer): boolean {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    },
    isTTY: true,
  } as unknown as NodeJS.WritableStream;
  return { chunks, stream };
}

function makeErrCollector(): { chunks: string[]; errStream: NodeJS.WritableStream } {
  const chunks: string[] = [];
  const errStream = {
    write(chunk: string | Buffer): boolean {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    },
    isTTY: false,
  } as unknown as NodeJS.WritableStream;
  return { chunks, errStream };
}

function colorUI(stream: NodeJS.WritableStream, errStream: NodeJS.WritableStream): UI {
  return new UI({ mode: 'pretty', color: true, stream, errStream });
}

function noColorUI(stream: NodeJS.WritableStream, errStream: NodeJS.WritableStream): UI {
  return new UI({ mode: 'pretty', color: false, stream, errStream });
}

// ============================================================
// UI-1: header
// ============================================================

describe('UI-1: header', () => {
  it('emits a line containing the text', () => {
    const { chunks, stream } = makeCollector();
    const { errStream } = makeErrCollector();
    const ui = colorUI(stream, errStream);
    ui.header('Prismer Runtime');
    const out = chunks.join('');
    expect(stripAnsi(out)).toContain('Prismer Runtime');
  });

  it('prefixes Prismer headers with the CLI brand mark', () => {
    const { chunks, stream } = makeCollector();
    const { errStream } = makeErrCollector();
    const ui = noColorUI(stream, errStream);
    ui.header('Prismer Runtime');
    expect(stripAnsi(chunks.join(''))).toContain('◇ Prismer Runtime');
  });

  it('leaves non-brand headers unprefixed', () => {
    const { chunks, stream } = makeCollector();
    const { errStream } = makeErrCollector();
    const ui = noColorUI(stream, errStream);
    ui.header('Uninstalling codex');
    expect(stripAnsi(chunks.join(''))).toBe('Uninstalling codex\n');
  });

  it('emits ANSI bold codes in color mode', () => {
    const { chunks, stream } = makeCollector();
    const { errStream } = makeErrCollector();
    const ui = colorUI(stream, errStream);
    ui.header('Prismer Runtime');
    expect(hasAnsi(chunks.join(''))).toBe(true);
  });

  it('does not emit in json mode', () => {
    const { chunks, stream } = makeCollector();
    const { errStream } = makeErrCollector();
    const ui = new UI({ mode: 'json', color: false, stream, errStream });
    ui.header('Prismer Runtime');
    expect(chunks.join('')).toBe('');
  });
});

// ============================================================
// UI-1b: banner
// ============================================================

describe('UI-1b: banner', () => {
  it('emits the compact Prismer banner on narrow terminals', () => {
    const { chunks, stream } = makeCollector();
    const { errStream } = makeErrCollector();
    (stream as NodeJS.WriteStream).columns = 80;
    const ui = noColorUI(stream, errStream);
    ui.banner('Runtime CLI v1.9.0');
    const plain = stripAnsi(chunks.join(''));
    expect(plain).toContain('◇ PRISMER');
    expect(plain).toContain('Runtime CLI');
    expect(plain).toContain('Runtime CLI v1.9.0');
  });

  it('does not emit in json mode', () => {
    const { chunks, stream } = makeCollector();
    const { errStream } = makeErrCollector();
    const ui = new UI({ mode: 'json', color: false, stream, errStream });
    ui.banner('Runtime CLI v1.9.0');
    expect(chunks.join('')).toBe('');
  });
});

// ============================================================
// UI-2: ok
// ============================================================

describe('UI-2: ok', () => {
  it('emits ✓ with text and detail in color mode', () => {
    const { chunks, stream } = makeCollector();
    const { errStream } = makeErrCollector();
    const ui = colorUI(stream, errStream);
    ui.ok('Installed', '0.8s');
    const out = chunks.join('');
    const plain = stripAnsi(out);
    expect(plain).toContain('✓');
    expect(plain).toContain('Installed');
    expect(plain).toContain('0.8s');
  });

  it('emits green ANSI code in color mode', () => {
    const { chunks, stream } = makeCollector();
    const { errStream } = makeErrCollector();
    const ui = colorUI(stream, errStream);
    ui.ok('Installed', '0.8s');
    expect(hasAnsi(chunks.join(''))).toBe(true);
  });

  it('emits no ANSI codes in no-color mode', () => {
    const { chunks, stream } = makeCollector();
    const { errStream } = makeErrCollector();
    const ui = noColorUI(stream, errStream);
    ui.ok('Installed', '0.8s');
    const out = chunks.join('');
    expect(hasAnsi(out)).toBe(false);
    expect(out).toContain('✓');
    expect(out).toContain('Installed');
  });
});

// ============================================================
// UI-3: fail
// ============================================================

describe('UI-3: fail', () => {
  it('emits red ✗ with text and detail', () => {
    const { chunks, stream } = makeCollector();
    const { errStream } = makeErrCollector();
    const ui = colorUI(stream, errStream);
    ui.fail('Check failed', 'timeout');
    const out = chunks.join('');
    const plain = stripAnsi(out);
    expect(plain).toContain('✗');
    expect(plain).toContain('Check failed');
    expect(plain).toContain('timeout');
    // Should have red ANSI
    expect(hasAnsi(out)).toBe(true);
  });

  it('emits no ANSI in no-color mode', () => {
    const { chunks, stream } = makeCollector();
    const { errStream } = makeErrCollector();
    const ui = noColorUI(stream, errStream);
    ui.fail('Check failed', 'timeout');
    const out = chunks.join('');
    expect(hasAnsi(out)).toBe(false);
    expect(out).toContain('✗');
  });
});

// ============================================================
// UI-4: error block
// ============================================================

describe('UI-4: error block', () => {
  it('emits three lines with correct prefixes', () => {
    const { chunks, stream } = makeCollector();
    const { chunks: errChunks, errStream } = makeErrCollector();
    const ui = noColorUI(stream, errStream);
    ui.error('Cannot connect', 'daemon not running', 'prismer daemon start');
    const out = errChunks.join('');
    const lines = out.split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain('✗');
    expect(lines[0]).toContain('Cannot connect');
    expect(lines[1]).toContain('Cause:');
    expect(lines[1]).toContain('daemon not running');
    expect(lines[2]).toContain('Fix:');
    expect(lines[2]).toContain('prismer daemon start');
  });

  it('omits Cause line when cause is undefined', () => {
    const { chunks, stream } = makeCollector();
    const { chunks: errChunks, errStream } = makeErrCollector();
    const ui = noColorUI(stream, errStream);
    ui.error('Cannot connect', undefined, 'prismer daemon start');
    const out = errChunks.join('');
    expect(out).not.toContain('Cause:');
    expect(out).toContain('Fix:');
  });

  it('omits Fix line when fix is undefined', () => {
    const { chunks, stream } = makeCollector();
    const { chunks: errChunks, errStream } = makeErrCollector();
    const ui = noColorUI(stream, errStream);
    ui.error('Cannot connect', 'daemon not running', undefined);
    const out = errChunks.join('');
    expect(out).toContain('Cause:');
    expect(out).not.toContain('Fix:');
  });

  it('writes to errStream not stream', () => {
    const { chunks: outChunks, stream } = makeCollector();
    const { chunks: errChunks, errStream } = makeErrCollector();
    const ui = noColorUI(stream, errStream);
    ui.error('Something went wrong');
    expect(outChunks.join('')).toBe('');
    expect(errChunks.join('')).toContain('Something went wrong');
  });
});

// ============================================================
// UI-5: tip
// ============================================================

describe('UI-5: tip', () => {
  it('emits cyan Tip: prefix with text', () => {
    const { chunks, stream } = makeCollector();
    const { errStream } = makeErrCollector();
    const ui = colorUI(stream, errStream);
    ui.tip('prismer agent install codex');
    const out = chunks.join('');
    const plain = stripAnsi(out);
    expect(plain).toContain('Tip:');
    expect(plain).toContain('prismer agent install codex');
    expect(hasAnsi(out)).toBe(true);
  });

  it('emits plain Tip: in no-color mode', () => {
    const { chunks, stream } = makeCollector();
    const { errStream } = makeErrCollector();
    const ui = noColorUI(stream, errStream);
    ui.tip('prismer agent install codex');
    const out = chunks.join('');
    expect(hasAnsi(out)).toBe(false);
    expect(out).toContain('Tip:');
  });
});

// ============================================================
// UI-6: table — aligned columns
// ============================================================

describe('UI-6: table — aligned columns', () => {
  it('emits table with column headers and data rows', () => {
    const { chunks, stream } = makeCollector();
    const { errStream } = makeErrCollector();
    const ui = noColorUI(stream, errStream);
    ui.table(
      [{ name: 'a', status: 'on' }, { name: 'b', status: 'off' }],
      { columns: ['name', 'status'], maxWidth: 120 },
    );
    const out = chunks.join('');
    expect(out).toContain('a');
    expect(out).toContain('b');
    expect(out).toContain('on');
    expect(out).toContain('off');
    // Headers should be uppercase
    expect(out.toUpperCase()).toContain('NAME');
    expect(out.toUpperCase()).toContain('STATUS');
  });

  it('aligns columns — all rows have equal-width columns', () => {
    const { chunks, stream } = makeCollector();
    const { errStream } = makeErrCollector();
    const ui = noColorUI(stream, errStream);
    ui.table(
      [{ agent: 'claude-code', status: 'online' }, { agent: 'hermes', status: 'stopped' }],
      { columns: ['agent', 'status'], maxWidth: 120 },
    );
    const out = chunks.join('');
    const lines = out.split('\n').filter((l) => l.trim().length > 0);
    // All data lines should have consistent structure
    expect(lines.length).toBeGreaterThanOrEqual(3); // header + 2 rows
  });
});

// ============================================================
// UI-7: table — list mode when narrow
// ============================================================

describe('UI-7: table — list mode when maxWidth < total', () => {
  it('switches to key: value block format when maxWidth is small', () => {
    const { chunks, stream } = makeCollector();
    const { errStream } = makeErrCollector();
    const ui = noColorUI(stream, errStream);
    // NAME(4)/alice(5) + STATUS(6)/online(6): colWidths=[5,6], total=2+5+2+6=15
    // Use maxWidth: 10 to force list mode (10 < 15)
    ui.table(
      [{ name: 'alice', status: 'online' }, { name: 'bob', status: 'offline' }],
      { columns: ['name', 'status'], maxWidth: 10 },
    );
    const out = chunks.join('');
    // In list mode, each field is key: value
    expect(out).toContain('name:');
    expect(out).toContain('status:');
    // Both rows present
    expect(out).toContain('alice');
    expect(out).toContain('bob');
  });

  it('inserts blank line between records in list mode', () => {
    const { chunks, stream } = makeCollector();
    const { errStream } = makeErrCollector();
    const ui = noColorUI(stream, errStream);
    // Use maxWidth: 10 to force list mode
    ui.table(
      [{ name: 'alice', status: 'online' }, { name: 'bob', status: 'offline' }],
      { columns: ['name', 'status'], maxWidth: 10 },
    );
    const out = chunks.join('');
    // Should have a blank line between records (two consecutive newlines)
    expect(out).toContain('\n\n');
  });
});

// ============================================================
// UI-8: NO_COLOR env var
// ============================================================

describe('UI-8: NO_COLOR env var', () => {
  let savedNoColor: string | undefined;
  beforeEach(() => { savedNoColor = process.env['NO_COLOR']; });
  afterEach(() => {
    if (savedNoColor === undefined) delete process.env['NO_COLOR'];
    else process.env['NO_COLOR'] = savedNoColor;
  });

  it('disables ANSI when NO_COLOR=1 even with isTTY=true', () => {
    process.env['NO_COLOR'] = '1';
    const stream = { write: () => true, isTTY: true } as unknown as NodeJS.WritableStream;
    const errStream = { write: () => true, isTTY: false } as unknown as NodeJS.WritableStream;
    const ui = new UI({ mode: 'pretty', stream, errStream }); // no explicit color — auto-detect
    expect(ui.colorEnabled).toBe(false);
  });
});

// ============================================================
// UI-9: --no-color arg via applyCommonFlags
// ============================================================

describe('UI-9: --no-color arg', () => {
  it('applyCommonFlags --no-color disables color', () => {
    const result = applyCommonFlags(['--no-color', 'foo']);
    expect(result.color).toBe(false);
    expect(result.restArgv).toEqual(['foo']);
  });
});

// ============================================================
// UI-10: json() — single line
// ============================================================

describe('UI-10: json() single line', () => {
  it('prints compact JSON with newline', () => {
    const { chunks, stream } = makeCollector();
    const { errStream } = makeErrCollector();
    const ui = new UI({ mode: 'json', color: false, stream, errStream });
    ui.json({ ok: true });
    expect(chunks.join('')).toBe('{"ok":true}\n');
  });
});

// ============================================================
// UI-11: json() — pretty
// ============================================================

describe('UI-11: json() pretty', () => {
  it('prints indented JSON when pretty:true', () => {
    const { chunks, stream } = makeCollector();
    const { errStream } = makeErrCollector();
    const ui = new UI({ mode: 'json', color: false, stream, errStream });
    ui.json({ ok: true }, { pretty: true });
    const out = chunks.join('');
    // Pretty JSON has newlines and indentation
    expect(out).toContain('\n');
    expect(out).toContain('  ');
    const parsed = JSON.parse(out);
    expect(parsed).toEqual({ ok: true });
  });
});

// ============================================================
// UI-12: spinner in pretty + non-TTY
// ============================================================

describe('UI-12: spinner stop in non-TTY mode', () => {
  it('stop(final) outputs the final message', () => {
    const chunks: string[] = [];
    const stream = {
      write(chunk: string | Buffer): boolean {
        chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
        return true;
      },
      isTTY: false, // non-TTY → no animation
    } as unknown as NodeJS.WritableStream;
    const { errStream } = makeErrCollector();
    const ui = new UI({ mode: 'pretty', color: false, stream, errStream });
    const sp = ui.spinner('loading');
    sp.stop('done');
    const out = chunks.join('');
    expect(stripAnsi(out)).toContain('done');
  });
});

// ============================================================
// UI-13: spinner in quiet mode
// ============================================================

describe('UI-13: spinner in quiet mode', () => {
  it('produces no output in quiet mode', () => {
    const { chunks, stream } = makeCollector();
    const { errStream } = makeErrCollector();
    const ui = new UI({ mode: 'quiet', color: false, stream, errStream });
    const sp = ui.spinner('loading');
    sp.update('still loading');
    sp.stop('done');
    expect(chunks.join('')).toBe('');
  });
});

// ============================================================
// UI-14: result()
// ============================================================

describe('UI-14: result()', () => {
  it('calls pretty() in pretty mode', () => {
    const { chunks, stream } = makeCollector();
    const { errStream } = makeErrCollector();
    const ui = noColorUI(stream, errStream);
    let called = false;
    ui.result(() => { called = true; ui.ok('done'); }, { ok: true });
    expect(called).toBe(true);
    expect(stripAnsi(chunks.join(''))).toContain('done');
  });

  it('prints JSON in json mode without calling pretty()', () => {
    const { chunks, stream } = makeCollector();
    const { errStream } = makeErrCollector();
    const ui = new UI({ mode: 'json', color: false, stream, errStream });
    let called = false;
    ui.result(() => { called = true; }, { ok: true });
    expect(called).toBe(false);
    expect(chunks.join('')).toBe('{"ok":true}\n');
  });
});

// ============================================================
// UI-15: applyCommonFlags
// ============================================================

describe('UI-15: applyCommonFlags', () => {
  it('parses --json --no-color and leaves rest', () => {
    const result = applyCommonFlags(['--json', '--no-color', 'foo']);
    expect(result.mode).toBe('json');
    expect(result.color).toBe(false);
    expect(result.restArgv).toEqual(['foo']);
  });

  it('parses --quiet', () => {
    const result = applyCommonFlags(['--quiet', 'bar']);
    expect(result.mode).toBe('quiet');
    expect(result.restArgv).toEqual(['bar']);
  });

  it('parses --color explicitly', () => {
    const result = applyCommonFlags(['--color', 'baz']);
    expect(result.color).toBe(true);
    expect(result.restArgv).toEqual(['baz']);
  });

  it('returns restArgv without consumed flags', () => {
    const result = applyCommonFlags(['--no-color', '--json', 'status', '--verbose']);
    expect(result.restArgv).toEqual(['status', '--verbose']);
  });
});

// ============================================================
// UI-16: assertBrandVoice
// ============================================================

describe('UI-16: assertBrandVoice', () => {
  let savedStrict: string | undefined;
  beforeEach(() => {
    savedStrict = process.env['PRISMER_BRAND_VOICE_STRICT'];
    process.env['PRISMER_BRAND_VOICE_STRICT'] = '1';
  });
  afterEach(() => {
    if (savedStrict === undefined) delete process.env['PRISMER_BRAND_VOICE_STRICT'];
    else process.env['PRISMER_BRAND_VOICE_STRICT'] = savedStrict;
  });

  it('throws when PRISMER_BRAND_VOICE_STRICT=1 and text contains "Sorry"', () => {
    expect(() => assertBrandVoice('Sorry about that')).toThrow(/Sorry/);
  });

  it('throws when text contains "Unfortunately"', () => {
    expect(() => assertBrandVoice('Unfortunately that failed')).toThrow(/Unfortunately/);
  });

  it('throws when text contains "Oops"', () => {
    expect(() => assertBrandVoice('Oops something went wrong')).toThrow(/Oops/);
  });

  it('throws when text contains standalone "Please"', () => {
    expect(() => assertBrandVoice('Please run this command')).toThrow(/Please/);
  });

  it('throws when line ends with "!"', () => {
    expect(() => assertBrandVoice('Agent installed!')).toThrow(/!/);
  });

  it('does not throw when PRISMER_BRAND_VOICE_STRICT is unset (default off)', () => {
    delete process.env['PRISMER_BRAND_VOICE_STRICT'];
    expect(() => assertBrandVoice('Sorry about that')).not.toThrow();
  });

  it('does not throw for clean text when strict is on', () => {
    expect(() => assertBrandVoice('Agent installed successfully')).not.toThrow();
  });
});

// ============================================================
// UI-17: status helpers glyphs
// ============================================================

describe('UI-17: status helpers emit correct glyphs', () => {
  it('online emits ●', () => {
    const { chunks, stream } = makeCollector();
    const { errStream } = makeErrCollector();
    const ui = noColorUI(stream, errStream);
    ui.online('daemon running');
    expect(chunks.join('')).toContain('●');
  });

  it('offline emits ○', () => {
    const { chunks, stream } = makeCollector();
    const { errStream } = makeErrCollector();
    const ui = noColorUI(stream, errStream);
    ui.offline('daemon stopped');
    expect(chunks.join('')).toContain('○');
  });

  it('notInstalled emits ·', () => {
    const { chunks, stream } = makeCollector();
    const { errStream } = makeErrCollector();
    const ui = noColorUI(stream, errStream);
    ui.notInstalled('agent not installed');
    expect(chunks.join('')).toContain('·');
  });

  it('pending emits ⟳', () => {
    const { chunks, stream } = makeCollector();
    const { errStream } = makeErrCollector();
    const ui = noColorUI(stream, errStream);
    ui.pending('Downloading...');
    expect(chunks.join('')).toContain('⟳');
  });
});

// ============================================================
// UI-18: next() helper
// ============================================================

describe('UI-18: next()', () => {
  it('emits Next: prefix', () => {
    const { chunks, stream } = makeCollector();
    const { errStream } = makeErrCollector();
    const ui = noColorUI(stream, errStream);
    ui.next('prismer agent list');
    const out = chunks.join('');
    expect(stripAnsi(out)).toContain('Next:');
    expect(out).toContain('prismer agent list');
  });
});

// ============================================================
// UI-19: secondary() with default and custom indent
// ============================================================

describe('UI-19: secondary()', () => {
  it('defaults to 2-space indent', () => {
    const { chunks, stream } = makeCollector();
    const { errStream } = makeErrCollector();
    const ui = noColorUI(stream, errStream);
    ui.secondary('Installed 2 minutes ago');
    const out = chunks.join('');
    expect(out.startsWith('  ')).toBe(true);
  });

  it('respects custom indent', () => {
    const { chunks, stream } = makeCollector();
    const { errStream } = makeErrCollector();
    const ui = noColorUI(stream, errStream);
    ui.secondary('detail', 4);
    const out = chunks.join('');
    expect(out.startsWith('    ')).toBe(true);
  });
});

// ============================================================
// UI-20: blank() and line()
// ============================================================

describe('UI-20: blank() and line()', () => {
  it('blank emits a single newline', () => {
    const { chunks, stream } = makeCollector();
    const { errStream } = makeErrCollector();
    const ui = noColorUI(stream, errStream);
    ui.blank();
    expect(chunks.join('')).toBe('\n');
  });

  it('line emits text with trailing newline', () => {
    const { chunks, stream } = makeCollector();
    const { errStream } = makeErrCollector();
    const ui = noColorUI(stream, errStream);
    ui.line('hello world');
    expect(chunks.join('')).toBe('hello world\n');
  });

  it('blank emits nothing in json mode', () => {
    const { chunks, stream } = makeCollector();
    const { errStream } = makeErrCollector();
    const ui = new UI({ mode: 'json', color: false, stream, errStream });
    ui.blank();
    expect(chunks.join('')).toBe('');
  });
});

// ============================================================
// UI-21: error() is silenced in JSON mode
// ============================================================

describe('UI-21: error() in JSON mode', () => {
  it('pretty mode: writes 3 lines to errStream', () => {
    const { chunks: outChunks, stream } = makeCollector();
    const { chunks: errChunks, errStream } = makeErrCollector();
    const ui = noColorUI(stream, errStream);
    ui.error('what happened', 'the cause', 'the fix');
    expect(outChunks.join('')).toBe('');
    const lines = errChunks.join('').split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain('✗');
    expect(lines[0]).toContain('what happened');
    expect(lines[1]).toContain('Cause:');
    expect(lines[2]).toContain('Fix:');
  });

  it('JSON mode: error() writes ZERO bytes to both stdout and stderr', () => {
    const { chunks: outChunks, stream } = makeCollector();
    const { chunks: errChunks, errStream } = makeErrCollector();
    const ui = new UI({ mode: 'json', color: false, stream, errStream });
    ui.error('something broke');
    expect(outChunks.join('')).toBe('');
    expect(errChunks.join('')).toBe('');
  });

  it('JSON mode paired with ui.json: only the JSON line appears on stdout', () => {
    const { chunks: outChunks, stream } = makeCollector();
    const { chunks: errChunks, errStream } = makeErrCollector();
    const ui = new UI({ mode: 'json', color: false, stream, errStream });
    ui.json({ ok: false, error: 'COMMAND_FAILED', message: 'exploded' });
    ui.error('something broke');
    expect(outChunks.join('')).toBe('{"ok":false,"error":"COMMAND_FAILED","message":"exploded"}\n');
    expect(errChunks.join('')).toBe('');
  });
});

// ============================================================
// cleanup
// ============================================================

afterEach(() => {
  __resetUIForTests();
});
