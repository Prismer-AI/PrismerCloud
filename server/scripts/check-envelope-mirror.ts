/**
 * Envelope double-mirror drift guard — docs/release201/31 §5.1.
 *
 * `ConversationContextEnvelope` lives in TWO hand-maintained copies:
 *   - cloud:   src/im/types/conversation-envelope.ts            (source of truth)
 *   - runtime: sdk/prismer-cloud/runtime/src/types/conversation-envelope.ts (mirror)
 *
 * They are structurally identical TODAY (verified 2026-05-31: every interface
 * field set matches; `EnvelopeRole` resolves to the same union on both sides —
 * cloud derives it from `TaskDispatchContextEntry['senderRole']`, runtime
 * inlines the literal `'human'|'agent'|'admin'|'system'`). This guard exists to
 * catch FUTURE drift: add a field on one side and forget the other → red.
 *
 * Layer-clean: this is a repo-level build/CI script (NOT runtime package code),
 * so it may read both files from the monorepo without violating the
 * "runtime never imports src/" rule.
 *
 * Run:  npx tsx scripts/check-envelope-mirror.ts
 * Exit: 0 = in sync, 1 = drift detected.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Run from repo root (the `check:envelope-mirror` npm script ensures cwd).
const ROOT = process.cwd();
const CLOUD = join(ROOT, 'src/im/types/conversation-envelope.ts');
const RUNTIME = join(ROOT, 'sdk/prismer-cloud/runtime/src/types/conversation-envelope.ts');

for (const f of [CLOUD, RUNTIME]) {
  if (!existsSync(f)) {
    console.error(`[envelope-mirror] ❌ cannot find ${f} — run from repo root.`);
    process.exit(2);
  }
}

/** Map of interfaceName → set of `field` / `field?` tokens. */
type InterfaceMap = Map<string, Set<string>>;

function stripComments(body: string): string {
  // Remove /* ... */ block comments and // line comments so they don't get
  // mis-parsed as fields.
  return body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function parseInterfaces(src: string): InterfaceMap {
  const out: InterfaceMap = new Map();
  // The envelope interfaces have NO nested object-literal braces, so a
  // non-greedy match up to the first `\n}` is exact.
  const re = /export interface (\w+)\s*\{([\s\S]*?)\n\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const name = m[1];
    const body = stripComments(m[2]);
    const fields = new Set<string>();
    for (const line of body.split('\n')) {
      const fm = line.match(/^\s*(\w+)(\?)?\s*:/);
      if (fm) fields.add(fm[1] + (fm[2] ?? ''));
    }
    out.set(name, fields);
  }
  return out;
}

function setDiff(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((x) => !b.has(x));
}

function main(): void {
  const cloud = parseInterfaces(readFileSync(CLOUD, 'utf8'));
  const runtime = parseInterfaces(readFileSync(RUNTIME, 'utf8'));

  const problems: string[] = [];
  const allNames = new Set([...cloud.keys(), ...runtime.keys()]);

  for (const name of [...allNames].sort()) {
    const c = cloud.get(name);
    const r = runtime.get(name);
    if (!c) {
      problems.push(`interface ${name}: present in runtime mirror but MISSING in cloud source`);
      continue;
    }
    if (!r) {
      problems.push(`interface ${name}: present in cloud source but MISSING in runtime mirror`);
      continue;
    }
    const onlyCloud = setDiff(c, r);
    const onlyRuntime = setDiff(r, c);
    if (onlyCloud.length || onlyRuntime.length) {
      problems.push(
        `interface ${name}: field drift` +
          (onlyCloud.length ? `\n    cloud-only:   ${onlyCloud.join(', ')}` : '') +
          (onlyRuntime.length ? `\n    runtime-only: ${onlyRuntime.join(', ')}` : ''),
      );
    }
  }

  // EnvelopeRole informational reminder (cloud derives, runtime inlines).
  const cloudRole = readFileSync(CLOUD, 'utf8').match(/export type EnvelopeRole = ([^\n;]+);/)?.[1]?.trim();
  const runtimeRole = readFileSync(RUNTIME, 'utf8').match(/export type EnvelopeRole = ([^\n;]+);/)?.[1]?.trim();
  if (cloudRole !== runtimeRole) {
    // Not a hard failure (cloud uses a derived type, runtime inlines the
    // literal) — but flag it so a human keeps the senderRole union in lockstep.
    console.warn(
      `[envelope-mirror] note: EnvelopeRole differs textually (cloud=\`${cloudRole}\` vs runtime=\`${runtimeRole}\`).\n` +
        `  Expected: cloud derives from TaskDispatchContextEntry['senderRole'], runtime inlines the same union.\n` +
        `  If you changed the senderRole vocabulary, update BOTH im-events.ts copies.`,
    );
  }

  if (problems.length) {
    console.error('[envelope-mirror] ❌ DRIFT detected between cloud source and runtime mirror:\n');
    for (const p of problems) console.error('  - ' + p);
    console.error(
      `\nFix: bring ${RUNTIME.replace(ROOT + '/', '')} back in lockstep with ${CLOUD.replace(ROOT + '/', '')} (docs/release201/31 §5.1).`,
    );
    process.exit(1);
  }

  console.log(`[envelope-mirror] ✅ in sync — ${cloud.size} interfaces match across cloud + runtime.`);
}

main();
