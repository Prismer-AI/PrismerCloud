import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const MARKER = '.prismer-native-managed.json';
const LEDGER = '.prismer-native-projections.json';
function stat(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
function inventory(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function walk(dir: string, prefix = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!prefix && [MARKER, '.prismer-skill-receipt.json'].includes(entry.name)) continue;
      const path = join(dir, entry.name),
        key = prefix + entry.name;
      if (entry.isDirectory()) walk(path, key + '/');
      else if (entry.isFile()) result[key] = createHash('sha256').update(readFileSync(path)).digest('hex');
      else throw new Error(`Unsupported native skill resource: ${path}`);
    }
  }
  walk(root);
  return result;
}
function isManagedUnmodified(path: string): boolean {
  if (!existsSync(join(path, MARKER))) return false;
  const recorded = JSON.parse(readFileSync(join(path, MARKER), 'utf8'));
  if (JSON.stringify(recorded) !== JSON.stringify(inventory(path))) {
    throw new Error(`User-modified managed native skill preserved: ${path}`);
  }
  return true;
}
function replace(stage: string, target: string) {
  const backup = join(dirname(target), `.${basename(target)}.old-${randomUUID()}`);
  const previous = stat(target);
  if (previous) renameSync(target, backup);
  try {
    renameSync(stage, target);
  } catch (error) {
    if (previous) renameSync(backup, target);
    throw error;
  }
  if (previous) rmSync(backup, { recursive: true, force: true });
}

/** Whole bundled directory, including licenses/fonts/scripts. Never overwrite user files. */
export function installHermesBundledSkill(source: string, target: string): void {
  const files = inventory(source);
  const existing = stat(target);
  if (existing?.isSymbolicLink()) return; // synced projection or user-owned link; never write through it
  mkdirSync(dirname(target), { recursive: true });
  if (!existing || isManagedUnmodified(target)) {
    const stage = join(dirname(target), `.${basename(target)}-${randomUUID()}`);
    try {
      cpSync(source, stage, { recursive: true });
      writeFileSync(join(stage, MARKER), JSON.stringify(files));
      replace(stage, target);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
    return;
  }
  // Legacy bootstrap had no ownership marker. Add missing resources only when
  // its entrypoint matches; retain its ownership and every pre-existing byte.
  const current = inventory(target);
  if (current['SKILL.md'] !== files['SKILL.md']) throw new Error(`Unmanaged native skill preserved: ${target}`);
  for (const [path, hash] of Object.entries(files)) {
    if (current[path] && current[path] !== hash)
      throw new Error(`Unmanaged native skill resource preserved: ${target}/${path}`);
  }
  for (const path of Object.keys(files)) {
    if (current[path]) continue;
    mkdirSync(dirname(join(target, path)), { recursive: true });
    cpSync(join(source, path), join(target, path), { errorOnExist: true, force: false });
  }
}

/** Expose pinned grants in the one native root; ownership lives outside source directories. */
export function projectHermesSkillRoot(sourceRoot: string, nativeRoot: string): void {
  if (!existsSync(sourceRoot) || resolve(sourceRoot) === resolve(nativeRoot)) return;
  mkdirSync(nativeRoot, { recursive: true });
  if (realpathSync(sourceRoot) === realpathSync(nativeRoot)) return;
  const ledgerPath = join(dirname(nativeRoot), LEDGER);
  const ledger: Record<string, string> = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : {};
  const wanted = new Set<string>();
  const persist = () => {
    const stage = `${ledgerPath}.${randomUUID()}`;
    writeFileSync(stage, JSON.stringify(ledger));
    renameSync(stage, ledgerPath);
  };
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || !existsSync(join(sourceRoot, entry.name, 'SKILL.md')))
      continue;
    const source = realpathSync(join(sourceRoot, entry.name)),
      target = join(nativeRoot, entry.name);
    wanted.add(entry.name);
    const existing = stat(target);
    if (existing?.isSymbolicLink()) {
      if (existsSync(target) && realpathSync(target) === source) continue;
      // A dangling managed link may be replaced, but never a user-retargeted link.
      if (!ledger[entry.name] || resolve(dirname(target), readlinkSync(target)) !== ledger[entry.name]) {
        throw new Error(`Conflicting unmanaged native skill ${entry.name}; use a unique canonical slug`);
      }
    } else if (existing && !isManagedUnmodified(target)) {
      const wantedFiles = inventory(source),
        actualFiles = inventory(target);
      if (Object.entries(wantedFiles).every(([path, hash]) => actualFiles[path] === hash)) continue;
      throw new Error(`Conflicting unmanaged native skill ${entry.name}; use a unique canonical slug`);
    }
    const stage = join(nativeRoot, `.${entry.name}-${randomUUID()}`);
    try {
      symlinkSync(source, stage, 'junction');
      replace(stage, target);
      ledger[entry.name] = source;
      persist();
    } finally {
      rmSync(stage, { force: true });
    }
  }
  for (const [name, source] of Object.entries(ledger)) {
    if (wanted.has(name)) continue;
    if (basename(name) !== name) throw new Error('Invalid native projection ledger');
    const target = join(nativeRoot, name);
    if (stat(target)?.isSymbolicLink() && resolve(dirname(target), readlinkSync(target)) === source) unlinkSync(target);
    delete ledger[name];
  }
  persist();
}

/** Remove only our obsolete links; sync must invalidate them before gateway reuse. */
export function pruneHermesSkillProjections(sourceRoot: string, nativeRoot: string): void {
  if (resolve(sourceRoot) === resolve(nativeRoot)) return;
  const canonicalRoot = existsSync(sourceRoot) ? realpathSync(sourceRoot) : resolve(sourceRoot);
  const ledgerPath = join(dirname(nativeRoot), LEDGER);
  if (!existsSync(ledgerPath)) return;
  const ledger: Record<string, string> = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  for (const [name, source] of Object.entries(ledger)) {
    if (basename(name) !== name) throw new Error('Invalid native projection ledger');
    if (resolve(source) !== resolve(canonicalRoot, name)) continue;
    if (existsSync(join(source, 'SKILL.md'))) continue;
    const target = join(nativeRoot, name);
    if (stat(target)?.isSymbolicLink() && resolve(dirname(target), readlinkSync(target)) === source) unlinkSync(target);
    delete ledger[name];
  }
  const stage = `${ledgerPath}.${randomUUID()}`;
  writeFileSync(stage, JSON.stringify(ledger));
  renameSync(stage, ledgerPath);
}
