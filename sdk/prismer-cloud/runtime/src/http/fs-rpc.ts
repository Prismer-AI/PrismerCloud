// FS RPC handlers — daemon side of the Cloud Relay Path (v1.9.0 Path 3).
//
// The runtime's RelayClient dispatches cloud-initiated `rpc.request` messages
// to handlers registered here. Each handler wraps the corresponding
// @prismer/sandbox-runtime FS primitive, using callPath: 'relay' so audit
// logs show the mobile → cloud → daemon origin (vs 'http' or 'native').
//
// Cloud endpoints (src/im/api/remote.ts) send:
//   { type: 'rpc.request', rpcId, method: 'fs.read', params: { agentId, path, ... } }
//
// Daemon replies:
//   { type: 'rpc.response', rpcId, result: {...} }   // or { ..., error: "..." }

import type { FsContext } from '@prismer/sandbox-runtime';
import {
  fsRead,
  fsWrite,
  fsDelete,
  fsEdit,
  fsList,
  fsSearch,
} from '@prismer/sandbox-runtime';
/** Structural type — anything with a registerRpcHandler method works here.
 *  RelayClient and TransportManager both satisfy this. */
interface RpcHandlerSink {
  registerRpcHandler(method: string, handler: (params: unknown) => Promise<unknown>): void;
}

export interface FsRpcDeps {
  /** Same provider as HTTP routes — given {agentId, workspace?}, returns an
   *  FsContext or undefined if FS is not available for that agent. */
  fsContextProvider: (req: { agentId: string; workspace?: string }) => FsContext | undefined;
}

interface FsRequestBase {
  agentId?: string;
  workspace?: string;
}

function requireContext(params: unknown, deps: FsRpcDeps): FsContext {
  const body = (params ?? {}) as FsRequestBase;
  if (!body.agentId) {
    throw new Error('agentId required');
  }
  const ctx = deps.fsContextProvider({ agentId: body.agentId, workspace: body.workspace });
  if (!ctx) {
    throw new Error(`FS not configured for agent: ${body.agentId}`);
  }
  // Mark call path so audit logs reflect relay origin.
  return { ...ctx, callPath: 'relay' as const };
}

/** Register all fs.* RPC handlers on a RelayClient or TransportManager.
 *  Safe to call multiple times — later registrations overwrite earlier ones. */
export function registerFsRpcHandlers(relayClient: RpcHandlerSink, deps: FsRpcDeps): void {
  relayClient.registerRpcHandler('fs.read', async (params) => {
    const ctx = requireContext(params, deps);
    const body = params as FsRequestBase & { path: string; offset?: number; limit?: number };
    return fsRead(ctx, { path: body.path, offset: body.offset, limit: body.limit });
  });

  relayClient.registerRpcHandler('fs.write', async (params) => {
    const ctx = requireContext(params, deps);
    const body = params as FsRequestBase & { path: string; content: string; encoding?: 'utf8' | 'base64' };
    return fsWrite(ctx, { path: body.path, content: body.content, encoding: body.encoding });
  });

  relayClient.registerRpcHandler('fs.delete', async (params) => {
    const ctx = requireContext(params, deps);
    const body = params as FsRequestBase & { path: string };
    return fsDelete(ctx, { path: body.path });
  });

  relayClient.registerRpcHandler('fs.edit', async (params) => {
    const ctx = requireContext(params, deps);
    const body = params as FsRequestBase & { path: string; oldString: string; newString: string };
    return fsEdit(ctx, { path: body.path, oldString: body.oldString, newString: body.newString });
  });

  relayClient.registerRpcHandler('fs.list', async (params) => {
    const ctx = requireContext(params, deps);
    const body = params as FsRequestBase & { path: string; maxDepth?: number };
    return fsList(ctx, { path: body.path, maxDepth: body.maxDepth });
  });

  relayClient.registerRpcHandler('fs.search', async (params) => {
    const ctx = requireContext(params, deps);
    const body = params as FsRequestBase & { query: string; path?: string; glob?: string };
    return fsSearch(ctx, { query: body.query, path: body.path, glob: body.glob });
  });
}
