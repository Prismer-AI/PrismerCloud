#!/usr/bin/env node

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const aipRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'aip-negative-conformance-'));
const fixturesDir = path.join(temporaryRoot, 'fixtures');

try {
  cpSync(path.join(aipRoot, 'fixtures'), fixturesDir, { recursive: true });
  const signaturePath = path.join(fixturesDir, 'signatures.json');
  const signatures = JSON.parse(readFileSync(signaturePath, 'utf8'));
  const validVector = signatures.vectors.find((vector) => vector.expectedValid === true);
  if (!validVector) throw new Error('No valid signature vector available for the negative control');
  validVector.signatureBase64 = `${validVector.signatureBase64[0] === 'A' ? 'B' : 'A'}${validVector.signatureBase64.slice(1)}`;
  writeFileSync(signaturePath, `${JSON.stringify(signatures, null, 2)}\n`, 'utf8');

  const env = { ...process.env, AIP_FIXTURES_DIR: fixturesDir };
  const ts = spawnSync('npm', ['exec', '--', 'tsx', 'test/conformance.test.ts'], {
    cwd: path.join(aipRoot, 'typescript'),
    env,
    encoding: 'utf8',
  });
  const configuredPython = process.env.AIP_PYTHON;
  const hasUv = !configuredPython && spawnSync('uv', ['--version']).status === 0;
  const python = configuredPython
    ? spawnSync(configuredPython, ['-m', 'pytest', 'tests/test_conformance_vectors.py', '-q'], {
        cwd: path.join(aipRoot, 'python'),
        env,
        encoding: 'utf8',
      })
    : hasUv
      ? spawnSync(
          'uv',
          [
            'run',
            '--isolated',
            '--python',
            '3.12',
            '--extra',
            'dev',
            'pytest',
            'tests/test_conformance_vectors.py',
            '-q',
          ],
          { cwd: path.join(aipRoot, 'python'), env, encoding: 'utf8' },
        )
      : spawnSync('python3', ['-m', 'pytest', 'tests/test_conformance_vectors.py', '-q'], {
          cwd: path.join(aipRoot, 'python'),
          env,
          encoding: 'utf8',
        });

  const tsConsumedVector = ts.status !== 0 && `${ts.stdout}\n${ts.stderr}`.includes(validVector.name);
  const pythonConsumedVector =
    python.status !== 0 && `${python.stdout}\n${python.stderr}`.includes('test_signature_vectors');

  if (!tsConsumedVector || !pythonConsumedVector) {
    if (!tsConsumedVector) {
      console.error('TypeScript suite did not fail on the tampered shared signature vector.');
      console.error(ts.stderr || ts.stdout);
    }
    if (!pythonConsumedVector) {
      console.error('Python suite did not fail in its shared signature-vector test.');
      console.error(python.stderr || python.stdout);
    }
    process.exitCode = 1;
  } else {
    console.log('Negative conformance control passed: TS and Python both rejected the tampered vector.');
  }
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
