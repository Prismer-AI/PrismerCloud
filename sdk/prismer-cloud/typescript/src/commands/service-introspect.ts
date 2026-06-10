/**
 * `cloud service introspect` — release201/07 §4.3 service-endpoint helper.
 *
 * Probes an HTTP / MCP / OpenAPI endpoint and returns a tool/endpoint
 * catalog the skill-authoring agent translates into a SKILL.md workflow.
 *
 * Usage:
 *   cloud service introspect <url> [--protocol auto|mcp|openapi]
 *
 * Output (JSON):
 *   { kind: 'mcp'|'openapi'|'unknown', tools: [...], endpoints: [...] }
 */

import { Command } from 'commander';

type ClientFactory = () => unknown;

const FETCH_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function probeOpenApi(url: string): Promise<{ found: boolean; spec?: any; specUrl?: string }> {
  const base = url.replace(/\/$/, '');
  const candidates = [
    `${base}/openapi.json`,
    `${base}/swagger.json`,
    `${base}/api/openapi.json`,
    `${base}/.well-known/openapi.json`,
  ];
  for (const candidate of candidates) {
    try {
      const res = await fetchWithTimeout(candidate, { headers: { Accept: 'application/json' } });
      if (res.ok) {
        const spec = await res.json();
        if (spec && (spec.openapi || spec.swagger)) {
          return { found: true, spec, specUrl: candidate };
        }
      }
    } catch {
      // continue
    }
  }
  return { found: false };
}

async function probeMcp(url: string): Promise<{ found: boolean; tools?: any[]; resources?: any[] }> {
  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    if (!res.ok) return { found: false };
    const body = await res.json();
    if (body?.result?.tools) {
      // optionally fetch resources too
      let resources: any[] = [];
      try {
        const r = await fetchWithTimeout(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'resources/list' }),
        });
        if (r.ok) {
          const rb = await r.json();
          if (Array.isArray(rb?.result?.resources)) resources = rb.result.resources;
        }
      } catch {
        // ignore
      }
      return { found: true, tools: body.result.tools, resources };
    }
  } catch {
    // ignore
  }
  return { found: false };
}

export function register(parent: Command, _getIMClient: ClientFactory, _getAPIClient: ClientFactory): void {
  const svc = parent
    .command('service')
    .description('Local service-endpoint helpers for skill-authoring (release201/07)');

  svc
    .command('introspect <url>')
    .description('Probe an HTTP / MCP / OpenAPI endpoint and emit a tool/endpoint catalog')
    .option('--protocol <kind>', 'Force protocol: auto | mcp | openapi', 'auto')
    .option('--json', 'Output JSON (default)', true)
    .action(async (url: string, opts: { protocol: 'auto' | 'mcp' | 'openapi' }) => {
      const protocol = opts.protocol ?? 'auto';
      if (protocol !== 'auto' && protocol !== 'mcp' && protocol !== 'openapi') {
        process.stderr.write(`Error: --protocol must be auto | mcp | openapi (got ${protocol})\n`);
        process.exit(1);
      }
      const result: any = { kind: 'unknown', tools: [], endpoints: [], probedAt: new Date().toISOString() };

      if (protocol === 'mcp' || protocol === 'auto') {
        const mcp = await probeMcp(url);
        if (mcp.found) {
          result.kind = 'mcp';
          result.tools = mcp.tools ?? [];
          result.resources = mcp.resources ?? [];
          process.stdout.write(JSON.stringify(result, null, 2) + '\n');
          return;
        }
      }

      if (protocol === 'openapi' || protocol === 'auto') {
        const oa = await probeOpenApi(url);
        if (oa.found) {
          result.kind = 'openapi';
          result.specUrl = oa.specUrl;
          // Translate operations into a flat endpoint list
          const paths = oa.spec?.paths ?? {};
          for (const p of Object.keys(paths)) {
            for (const method of Object.keys(paths[p])) {
              if (['get', 'post', 'put', 'delete', 'patch'].includes(method.toLowerCase())) {
                const op = paths[p][method];
                result.endpoints.push({
                  path: p,
                  method: method.toUpperCase(),
                  operationId: op?.operationId ?? null,
                  summary: op?.summary ?? null,
                });
              }
            }
          }
          process.stdout.write(JSON.stringify(result, null, 2) + '\n');
          return;
        }
      }

      // unknown — emit a warning but still output JSON envelope
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    });
}
