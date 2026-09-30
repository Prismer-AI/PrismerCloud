// Compare the committed CLI against the current build using real Node processes.
// Run after npm run build: node scripts/benchmark-turn-startup.mjs [samples=9]
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { build } from 'esbuild';

const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(sdkRoot, '../..');
const samples = Number(process.argv[2] ?? 9);
if (!Number.isInteger(samples) || samples < 3 || samples > 100) throw new Error('samples must be 3..100');
const baseline = resolve(sdkRoot, 'dist/.benchmark-baseline.js');
const headSource = (file) => execFileSync('git', ['show', `HEAD:sdk/prismer/${file}`], { cwd: repoRoot, encoding: 'utf8' });
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
const committedTurn = headSource('src/cli/commands/turn.ts');

try {
  await build({
    stdin: { contents: headSource('src/bin/prismer.ts'), loader: 'ts', resolveDir: resolve(sdkRoot, 'src/bin') },
    outfile: baseline, bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external',
    plugins: [{ name: 'committed-turn', setup(builder) {
      builder.onLoad({ filter: /src\/cli\/commands\/turn\.ts$/ }, () => ({ contents: committedTurn, loader: 'ts' }));
    } }],
  });
  const paths = { baseline, current: resolve(sdkRoot, 'dist/cli.js') };
  const observations = [];
  // Alternate to reduce ordering bias. First process in each group is retained.
  for (let sample = 0; sample < samples; sample++) {
    for (const variant of sample % 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
      const start = performance.now();
      const child = spawnSync(process.execPath, [paths[variant], 'turn', 'capabilities'], { encoding: 'utf8', timeout: 20_000 });
      const elapsedMs = performance.now() - start;
      if (child.status !== 0 || JSON.parse(child.stdout).protocolVersion !== 2) throw new Error(`${variant}: ${child.stderr}`);
      observations.push({ variant, sample, elapsedMs });
    }
  }
  const summary = Object.fromEntries(Object.keys(paths).map((variant) => {
    const values = observations.filter((o) => o.variant === variant).map((o) => o.elapsedMs).sort((a, b) => a - b);
    return [variant, { samples: values.length, minMs: values[0], p50Ms: values[Math.ceil(values.length * .5) - 1], p95Ms: values[Math.ceil(values.length * .95) - 1] }];
  }));
  process.stdout.write(JSON.stringify({
    scope: 'local-node-cli-capability-probe; excludes provider, network and inference',
    baselineRevision: revision, node: process.version, platform: process.platform, arch: process.arch,
    currentEntryBytes: Buffer.byteLength(readFileSync(paths.current)), summary, observations,
  }, null, 2) + '\n');
} finally {
  try { unlinkSync(baseline); } catch { /* No output if baseline build failed. */ }
}
