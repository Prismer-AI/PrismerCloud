import { accessSync, constants, existsSync, statSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import { parseEnv } from 'node:util';
import { parse } from 'yaml';

export interface SkillAvailabilityContext {
  platform: string;
  environments: string[];
  disabled: string[];
  hasCommand: (command: string) => boolean;
  env: Record<string, string | undefined>;
}

export function skillFrontmatter(content: string): Record<string, any> {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];
  if (!block) return {};
  const value = parse(block);
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function strings(value: unknown): string[] {
  return (Array.isArray(value) ? value : typeof value === 'string' ? [value] : []).filter(
    (item): item is string => typeof item === 'string',
  );
}

export function localSkillAvailabilityContext(
  env: Record<string, string | undefined> = process.env,
): SkillAvailabilityContext {
  return {
    platform: process.platform,
    environments: [
      ...(existsSync('/.dockerenv') ? ['docker'] : []),
      ...(existsSync('/run/s6') || existsSync('/package/admin/s6-overlay') ? ['s6'] : []),
    ],
    disabled: [],
    env,
    hasCommand(command) {
      if (!/^[\w.+-]+$/.test(command)) return false;
      const suffixes = process.platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : [''];
      return (env.PATH ?? '')
        .split(delimiter)
        .filter(Boolean)
        .some((dir) =>
          suffixes.some((suffix) => {
            try {
              const file = join(dir, command + suffix);
              accessSync(file, constants.X_OK);
              return statSync(file).isFile();
            } catch {
              return false;
            }
          }),
        );
    },
  };
}

/** Match the gateway: dotenv overrides inherited values, later profile files win. */
export function skillAvailabilityContextFromEnvFiles(paths: readonly string[]): SkillAvailabilityContext {
  const env = { ...process.env };
  for (const path of paths) {
    try {
      Object.assign(env, parseEnv(readFileSync(path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return localSkillAvailabilityContext(env);
}

/** Availability is an offer-time check, not proof of account authentication. */
export function assessSkillAvailability(
  content: string,
  context = localSkillAvailabilityContext(),
): {
  status: 'available' | 'filtered' | 'not-ready' | 'invalid';
  reasons: string[];
} {
  let fm;
  try {
    fm = skillFrontmatter(content);
  } catch {
    return { status: 'invalid', reasons: ['invalid-frontmatter'] };
  }
  const platform = (value: string) => ({ darwin: 'macos', win32: 'windows' })[value] ?? value;
  const reasons: string[] = [];
  if (fm.metadata?.internal === true) reasons.push('internal');
  if (context.disabled.includes(fm.name)) reasons.push('disabled');
  const platforms = strings(fm.platforms).map(platform);
  if (platforms.length && !platforms.includes(platform(context.platform))) reasons.push('platform');
  const environments = strings(fm.environments);
  if (environments.length && !environments.some((env) => context.environments.includes(env)))
    reasons.push('environment');
  if (reasons.length) return { status: 'filtered', reasons };
  // Do not invent undeclared prerequisites: skills may contain dependency setup instructions.
  const commands = strings(fm.prerequisites?.commands);
  for (const command of new Set(commands)) {
    if (!context.hasCommand(command)) reasons.push(`missing-command:${command}`);
  }
  for (const key of strings(fm.prerequisites?.env_vars)) {
    if (!context.env[key]?.trim()) reasons.push(`missing-env:${key}`);
  }
  return { status: reasons.length ? 'not-ready' : 'available', reasons };
}

/** Scan only skill entrypoints; supporting references are never registrations. */
export function inspectSkillTree(
  root: string,
  context = localSkillAvailabilityContext(),
): Array<{
  name: string;
  path: string;
  status: ReturnType<typeof assessSkillAvailability>['status'];
  reasons: string[];
  nativeReplaces: string[];
}> {
  const out: ReturnType<typeof inspectSkillTree> = [];
  const visited = new Set<string>();
  function walk(dir: string) {
    try {
      const real = realpathSync(dir);
      if (visited.has(real)) return;
      visited.add(real);
    } catch {
      return;
    }
    const path = join(dir, 'SKILL.md');
    if (existsSync(path)) {
      let content: string;
      try {
        content = readFileSync(path, 'utf8');
      } catch {
        out.push({ name: basename(dir), path, status: 'invalid', reasons: ['unreadable'], nativeReplaces: [] });
        return;
      }
      let fm: Record<string, any> = {};
      try {
        fm = skillFrontmatter(content);
      } catch {
        /* retain invalid status */
      }
      out.push({
        name: typeof fm.name === 'string' ? fm.name : basename(dir),
        path,
        ...(typeof fm.name === 'string'
          ? assessSkillAvailability(content, context)
          : { status: 'invalid' as const, reasons: ['missing-name'] }),
        nativeReplaces: strings(fm.metadata?.nativeReplaces),
      });
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const child = join(dir, entry.name);
      try {
        if (entry.isDirectory() || (entry.isSymbolicLink() && statSync(child).isDirectory())) walk(child);
      } catch {
        /* dangling link */
      }
    }
  }
  if (existsSync(root)) walk(root);
  return out;
}

/** Only previously attributed runtime entries may be removed on policy refresh. */
export function reconcileSkillDisables(existing: string[], previouslyManaged: string[], computed: string[]) {
  const owned = new Set(previouslyManaged);
  const operator = existing.filter((name) => !owned.has(name));
  return {
    disabled: [...new Set([...operator, ...computed])],
    managed: [...new Set(computed.filter((name) => !operator.includes(name)))],
  };
}

/** Bundled catalog policy, independent of a grant's prerequisites or installation state. */
export function explicitGrantNativeDisables(bundledRoot: string): string[] {
  return [
    ...new Set(
      inspectSkillTree(bundledRoot).flatMap((entry) => {
        const fm = skillFrontmatter(readFileSync(entry.path, 'utf8'));
        return fm.metadata?.requiresExplicitGrant === true ? entry.nativeReplaces : [];
      }),
    ),
  ];
}

/** Shared mirrors may repeat bytes; different implementations need distinct imported names. */
export function assertUnambiguousSkillImports(inventories: Array<ReturnType<typeof inspectSkillTree>>): void {
  const names = new Map<string, { paths: Set<string>; roots: Set<number> }>();
  inventories.forEach((entries, root) => {
    for (const entry of entries) {
      if (entry.nativeReplaces.includes(entry.name)) {
        throw new Error(
          `Skill ${entry.name} replaces itself; use a unique canonical slug and nativeReplaces: [upstream-name]`,
        );
      }
      const identity = names.get(entry.name) ?? { paths: new Set<string>(), roots: new Set<number>() };
      identity.paths.add(realpathSync(entry.path));
      identity.roots.add(root);
      names.set(entry.name, identity);
    }
  });
  for (const [name, identity] of names) {
    if (identity.paths.size > 1 && identity.roots.size > 1) {
      const contents = [...identity.paths].map((path) => readFileSync(path));
      if (contents.every((content) => content.equals(contents[0]!))) continue;
      throw new Error(
        `Ambiguous skill ${name} across roots; use a unique canonical slug and nativeReplaces: [upstream-name]. Paths: ${[...identity.paths].join(', ')}`,
      );
    }
  }
}
