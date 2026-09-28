import bundledManifest from '../../../../components/eaas-pi-components.manifest.json';

type Declaration = { source?: string; version?: string; name: string };
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Manifest authorization precedes the fixed factories; it never dynamically imports tenant code. */
export function assertComponentDeclaration(manifest: unknown, declaration: Declaration): void {
  const invalid = (): never => {
    throw new Error('invalid component manifest');
  };
  if (
    !object(manifest) ||
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.components) ||
    !manifest.components.length
  )
    invalid();
  const entries = new Map<string, { version: string; tools: string[] }>();
  for (const raw of (manifest as { components: unknown[] }).components) {
    if (
      !object(raw) ||
      typeof raw.package !== 'string' ||
      entries.has(raw.package) ||
      typeof raw.version !== 'string' ||
      !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(raw.version) ||
      typeof raw.integrity !== 'string' ||
      !raw.integrity.startsWith('sha512-') ||
      !Array.isArray(raw.tools) ||
      !raw.tools.length ||
      raw.tools.some((tool) => typeof tool !== 'string' || !/^[a-z][a-z0-9_]*$/.test(tool)) ||
      new Set(raw.tools).size !== raw.tools.length
    )
      invalid();
    const row = raw as { package: string; version: string; integrity: string; tools: string[] };
    const hash = row.integrity.slice(7);
    const bytes = Buffer.from(hash, 'base64');
    if (bytes.length !== 64 || bytes.toString('base64') !== hash) invalid();
    entries.set(row.package, { version: row.version, tools: row.tools });
  }
  const entry = declaration.source ? entries.get(declaration.source) : undefined;
  if (!entry || !entry.tools.includes(declaration.name)) throw new Error('component manifest rejects undeclared tool');
  if (entry.version !== declaration.version) throw new Error('component manifest version mismatch');
}

export function assertBundledComponentDeclaration(declaration: Declaration): void {
  assertComponentDeclaration(bundledManifest, declaration);
}
