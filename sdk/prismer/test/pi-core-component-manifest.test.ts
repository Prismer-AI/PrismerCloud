import { describe, expect, it } from 'vitest';
import manifest from '../components/eaas-pi-components.manifest.json';
import {
  assertBundledComponentDeclaration,
  assertComponentDeclaration,
} from '../src/adapters/runtime-engine/pi-core/component-manifest.js';

describe('bundled component manifest authorization', () => {
  it('accepts every exact declared tool from the shipped manifest', () => {
    for (const component of manifest.components)
      for (const name of component.tools)
        expect(() =>
          assertBundledComponentDeclaration({ source: component.package, version: component.version, name }),
        ).not.toThrow();
  });
  it('uses manifest version rather than a duplicated implementation constant', () => {
    const copy = structuredClone(manifest);
    copy.components[0].version = '9.1.0';
    expect(() =>
      assertComponentDeclaration(copy, { source: copy.components[0].package, version: '9.1.0', name: 'grep' }),
    ).not.toThrow();
    expect(() =>
      assertComponentDeclaration(copy, { source: copy.components[0].package, version: '0.84.2', name: 'grep' }),
    ).toThrow(/version mismatch/);
  });
  it.each(['unknown-source', 'unknown-tool', 'removed-tool', 'duplicate-package', 'bad-integrity', 'bad-schema'])(
    'rejects %s without invoking any component factory',
    (kind) => {
      const copy = structuredClone(manifest);
      const declaration = { source: copy.components[0].package, version: copy.components[0].version, name: 'grep' };
      if (kind === 'unknown-source') declaration.source = 'tenant-unlisted-package';
      if (kind === 'unknown-tool') declaration.name = 'bash';
      if (kind === 'removed-tool') copy.components[0].tools = ['find'];
      if (kind === 'duplicate-package') copy.components.push({ ...copy.components[0] });
      if (kind === 'bad-integrity') copy.components[0].integrity = 'sha512-short';
      if (kind === 'bad-schema') copy.schemaVersion = 99;
      expect(() => assertComponentDeclaration(copy, declaration)).toThrow(
        /invalid component manifest|component manifest rejects/,
      );
    },
  );
});
