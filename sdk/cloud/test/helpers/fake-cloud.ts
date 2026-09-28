/**
 * Shared real-HTTP test harness for the `cloud` CLI verbs.
 *
 * Extracted verbatim from `commands-apc-ack-meta.test.ts` when a second suite
 * (`commands-apc-git-cli.test.ts`) needed it. The discipline it encodes is the
 * point (apc/11 §1):
 *
 *  - `fetch` is NOT mocked. Cases run a REAL `node:http` server on 127.0.0.1
 *    and a REAL `PrismerClient`, so the oracle is the request the server
 *    actually received plus the process exit code — never an injected transport.
 *  - `runCli` drives the REAL commander tree and captures the REAL exit code,
 *    so an exit swallowed by a handler's own catch shows up as a wrong code
 *    rather than as a passing test.
 */

import { Command } from 'commander';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { PrismerClient } from '../../src/index';

// K 空腔闭合 — 增 query 字段（path 之外的查询串原样记录），供断言
// `/me/external-contacts?workspaceId=…` 这类必需查询参数不被静默丢失。
export type Recorded = { method: string; path: string; query: string; body: unknown };
export type Route = (req: { method: string; path: string; query: string; body: any }) => { status: number; json: unknown };

export interface FakeCloud {
  baseUrl: string;
  calls: Recorded[];
  setRoute(route: Route): void;
  close(): Promise<void>;
}

export async function startFakeCloud(initial: Route): Promise<FakeCloud> {
  let route = initial;
  const calls: Recorded[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.from(c)));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = undefined;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      const [path, query = ''] = (req.url ?? '').split('?');
      const method = (req.method ?? 'GET').toUpperCase();
      calls.push({ method, path, query, body });
      const out = route({ method, path, query, body });
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    setRoute(next) {
      route = next;
    },
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

export const API_KEY = 'sk-prismer-live-testkey00000000000000000000000000000000000000000000000000';

export function makeRealClient(baseUrl: string): PrismerClient {
  // NOTE: no `fetch` override → the client uses the global fetch and really
  // talks to the server above. This is the point of the whole harness.
  return new PrismerClient({ apiKey: API_KEY, baseUrl });
}

export async function runCli(
  register: (parent: Command, im: () => PrismerClient, api: () => PrismerClient) => void,
  client: PrismerClient,
  argv: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const program = new Command();
  program.exitOverride();
  register(program, () => client, () => client);

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origStdoutWrite = process.stdout.write;
  const origStderrWrite = process.stderr.write;
  process.stdout.write = ((s: string | Uint8Array) => {
    stdoutChunks.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array) => {
    stderrChunks.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;

  let exitCode = 0;
  const origExit = process.exit;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__exit_${exitCode}`);
  }) as typeof process.exit;

  try {
    await program.parseAsync(['node', 'cloud', ...argv]);
  } catch (err) {
    if (!(err instanceof Error && err.message.startsWith('__exit_'))) throw err;
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    process.exit = origExit;
  }
  return { exitCode, stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') };
}
