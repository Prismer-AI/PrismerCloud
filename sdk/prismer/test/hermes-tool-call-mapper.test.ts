// release203/15 §WS-G — Hermes tool args → structured ToolCallDetail.
// Pure-function tests over mapHermesToolDetail (no spawn, no network).

import { describe, expect, it } from 'vitest';
import {
  extractCliFromPython,
  mapHermesToolDetail,
} from '../src/adapters/persistence/hermes/tool-call-mapper.js';

describe('mapHermesToolDetail — Hermes tool args → ToolCallDetail', () => {
  it('execute_code wrapping subprocess → shell{command} = extracted CLI, python kept on script (R5.2)', () => {
    const code = 'import subprocess\nsubprocess.run(["echo", "hi"])';
    const detail = mapHermesToolDetail('execute_code', { code });
    expect(detail).toEqual({
      type: 'shell',
      command: 'echo hi',
      script: code,
      commandSource: 'argv',
    });
  });

  it('execute_code with plain python (no subprocess) keeps the whole source as command — negative control', () => {
    const code = 'x = 1\nprint(x + 1)';
    const detail = mapHermesToolDetail('execute_code', { code });
    expect(detail).toEqual({ type: 'shell', command: code });
    expect((detail as Record<string, unknown>).commandSource).toBeUndefined();
  });

  it('terminal/bash/run_command → shell{command} from args.command', () => {
    for (const name of ['terminal', 'bash', 'shell', 'run_command']) {
      const detail = mapHermesToolDetail(name, { command: 'echo TOKEN' });
      expect(detail).toEqual({ type: 'shell', command: 'echo TOKEN' });
    }
  });

  it('pairs output + exitCode into the SAME shell detail at completion', () => {
    const detail = mapHermesToolDetail('execute_code', { code: 'echo hi' }, 'hi\n', 0);
    expect(detail).toEqual({
      type: 'shell',
      command: 'echo hi',
      output: 'hi\n',
      exitCode: 0,
    });
  });

  it('omits output when the gateway dropped it (caveat) — no fake placeholder', () => {
    const detail = mapHermesToolDetail('execute_code', { code: 'echo hi' });
    expect(detail).toEqual({ type: 'shell', command: 'echo hi' });
    expect((detail as Record<string, unknown>).output).toBeUndefined();
  });

  it('read_file → read{filePath}, content from output when present', () => {
    expect(mapHermesToolDetail('read_file', { file_path: '/a/b.ts' })).toEqual({
      type: 'read',
      filePath: '/a/b.ts',
    });
    expect(mapHermesToolDetail('cat', { path: '/a/b.ts' }, 'file contents')).toEqual({
      type: 'read',
      filePath: '/a/b.ts',
      content: 'file contents',
    });
  });

  it('write_file → write{filePath,content}', () => {
    expect(mapHermesToolDetail('write_file', { file_path: '/x.txt', content: 'hello' })).toEqual({
      type: 'write',
      filePath: '/x.txt',
      content: 'hello',
    });
  });

  it('edit_file/apply_patch → edit with unifiedDiff', () => {
    expect(
      mapHermesToolDetail('apply_patch', { file_path: '/x.ts', patch: '@@ -1 +1 @@' }),
    ).toEqual({ type: 'edit', filePath: '/x.ts', unifiedDiff: '@@ -1 +1 @@' });
  });

  it('search/grep/web_search → search{query,toolName}', () => {
    expect(mapHermesToolDetail('web_search', { query: 'prismer' })).toEqual({
      type: 'search',
      query: 'prismer',
      toolName: 'web_search',
    });
    expect(mapHermesToolDetail('grep', { pattern: 'foo' })).toEqual({
      type: 'search',
      query: 'foo',
      toolName: 'grep',
    });
  });

  it('fetch/browser/open_url → fetch{url}', () => {
    expect(mapHermesToolDetail('fetch', { url: 'https://x.dev' })).toEqual({
      type: 'fetch',
      url: 'https://x.dev',
    });
    expect(mapHermesToolDetail('open_url', { url: 'https://x.dev' }, '<html>')).toEqual({
      type: 'fetch',
      url: 'https://x.dev',
      result: '<html>',
    });
  });

  it('parses a JSON-string args payload', () => {
    expect(mapHermesToolDetail('execute_code', '{"code":"echo z"}')).toEqual({
      type: 'shell',
      command: 'echo z',
    });
  });

  it('unknown tool → undefined (falls back to inputSummary, no regression)', () => {
    expect(mapHermesToolDetail('prismer.approval.request_human_approval', {})).toBeUndefined();
    expect(mapHermesToolDetail('some_unmapped_tool', { x: 1 })).toBeUndefined();
  });

  it('file tool with no path → undefined (cannot build a meaningful detail)', () => {
    expect(mapHermesToolDetail('read_file', {})).toBeUndefined();
  });
});

// memory203/18 R5.2 — table-driven argv extraction from python execute_code
// wrappers. The live symptom: timeline showed "import subprocess (+9 行)"
// instead of `$ prismer memory search …`.
describe('extractCliFromPython', () => {
  const cases: Array<{ name: string; code: string; expected: string | null }> = [
    {
      name: 'subprocess.run with a list argv → joined + quoted',
      code: [
        'import subprocess',
        "result = subprocess.run(['prismer', 'memory', 'search', 'k8s reaper'], capture_output=True, text=True)",
        'print(result.stdout)',
      ].join('\n'),
      expected: "prismer memory search 'k8s reaper'",
    },
    {
      name: 'subprocess.check_output with double-quoted list',
      code: 'import subprocess\nout = subprocess.check_output(["prismer", "memory", "load", "prismer://memory/x.pkf"])',
      expected: 'prismer memory load prismer://memory/x.pkf',
    },
    {
      name: 'subprocess.run with a string command (shell=True)',
      code: "import subprocess\nsubprocess.run('prismer memory search reaper', shell=True)",
      expected: 'prismer memory search reaper',
    },
    {
      name: 'subprocess.Popen list argv',
      code: "from subprocess import Popen\nimport subprocess\np = subprocess.Popen(['ls', '-la'])",
      expected: 'ls -la',
    },
    {
      name: 'os.system string',
      code: 'import os\nos.system("prismer task list")',
      expected: 'prismer task list',
    },
    {
      name: 'multiple calls join with && in source order',
      code: [
        'import subprocess, os',
        "subprocess.run(['git', 'status'])",
        'os.system("git diff")',
      ].join('\n'),
      expected: 'git status && git diff',
    },
    {
      name: 'jupyter bang line',
      code: '!prismer memory search reaper',
      expected: 'prismer memory search reaper',
    },
    {
      name: 'plain python without subprocess → null (negative control)',
      code: 'for i in range(3):\n    print(i * 2)',
      expected: null,
    },
    {
      name: 'dynamic argv (variable element) is not guessed → null',
      code: "import subprocess\nquery = build_query()\nsubprocess.run(['prismer', 'memory', 'search', query])",
      expected: null,
    },
    {
      name: 'empty / whitespace source → null',
      code: '   \n  ',
      expected: null,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(extractCliFromPython(c.code)).toBe(c.expected);
    });
  }

  it('caps a runaway multi-call join at 400 chars', () => {
    const many = Array.from({ length: 40 }, (_, i) => `subprocess.run(['echo', 'token-${i}-padding-padding'])`).join(
      '\n',
    );
    const out = extractCliFromPython(`import subprocess\n${many}`);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(401); // 400 + ellipsis
    expect(out!.endsWith('…')).toBe(true);
  });
});
