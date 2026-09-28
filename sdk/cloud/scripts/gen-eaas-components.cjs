#!/usr/bin/env node
'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- Standalone Node CommonJS release entrypoint. */

const { readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value, expected) {
  return (
    object(value) && Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key))
  );
}
function https(value) {
  try {
    const url = new URL(value);
    return (
      typeof value === 'string' &&
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}
function validateCatalog(catalog) {
  const invalid = () => {
    throw new Error('invalid EaaS component catalog');
  };
  if (
    !keys(catalog, ['schemaVersion', 'upstreamRepository', 'components']) ||
    catalog.schemaVersion !== 1 ||
    !https(catalog.upstreamRepository) ||
    !Array.isArray(catalog.components) ||
    !catalog.components.length
  )
    invalid();
  const packages = new Set();
  for (const row of catalog.components) {
    if (
      !keys(row, ['package', 'version', 'integrity', 'tier', 'tools', 'catalogStatus', 'distribution', 'provenance']) ||
      typeof row.package !== 'string' ||
      !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(row.package) ||
      packages.has(row.package) ||
      typeof row.version !== 'string' ||
      !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(row.version) ||
      typeof row.integrity !== 'string' ||
      !row.integrity.startsWith('sha512-') ||
      !['official', 'community'].includes(row.tier) ||
      row.catalogStatus !== 'curated' ||
      row.distribution !== 'runtime-bundle' ||
      !Array.isArray(row.tools) ||
      !row.tools.length ||
      row.tools.some((tool) => typeof tool !== 'string' || !/^[a-z][a-z0-9_]*$/.test(tool)) ||
      new Set(row.tools).size !== row.tools.length ||
      !keys(row.provenance, ['author', 'repository', 'packageUrl']) ||
      typeof row.provenance.author !== 'string' ||
      !row.provenance.author.trim() ||
      !https(row.provenance.repository) ||
      !https(row.provenance.packageUrl) ||
      row.provenance.packageUrl !== `https://www.npmjs.com/package/${row.package}`
    )
      invalid();
    if (row.tier === 'official' && row.provenance.repository !== catalog.upstreamRepository) invalid();
    const encoded = row.integrity.slice(7);
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length !== 64 || bytes.toString('base64') !== encoded) invalid();
    packages.add(row.package);
  }
}

function syncCatalog({ catalogPath, manifestPath, lockPath, check }) {
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  validateCatalog(catalog);
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  for (const row of catalog.components) {
    const pin = lock.packages?.[`node_modules/${row.package}`];
    if (
      pin?.version !== row.version ||
      pin?.integrity !== row.integrity ||
      lock.packages?.['']?.dependencies?.[row.package] !== row.version
    )
      throw new Error(`component catalog lock mismatch: ${row.package}`);
  }
  const manifest = {
    schemaVersion: 1,
    components: catalog.components.map(({ package: name, version, integrity, tier, tools }) => ({
      package: name,
      version,
      integrity,
      tier,
      tools,
    })),
  };
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
  if (check) {
    let current;
    try {
      current = readFileSync(manifestPath, 'utf8');
    } catch {
      throw new Error('component manifest drift: missing mirror');
    }
    if (current !== bytes) throw new Error('component manifest drift: run gen-eaas-components.cjs');
  } else writeFileSync(manifestPath, bytes);
}

module.exports = { validateCatalog, syncCatalog };
if (require.main === module) {
  try {
    if (process.argv.slice(2).some((arg) => arg !== '--check'))
      throw new Error('usage: gen-eaas-components.cjs [--check]');
    syncCatalog({
      catalogPath: resolve(__dirname, '../catalog/eaas-components.json'),
      manifestPath: resolve(__dirname, '../../prismer/components/eaas-pi-components.manifest.json'),
      lockPath: resolve(__dirname, '../../prismer/package-lock.json'),
      check: process.argv.includes('--check'),
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
