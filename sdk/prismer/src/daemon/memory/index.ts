// Daemon memory module barrel.
//
// Phase-0 (Line C C1+C5) exports: types, envelope schemas, store, search,
// outbox (write-only), crypto stub, rpc route attacher.
//
// Phase-1 (C2+C3+C4+C6) will add: hooks (session_start/before_llm_call),
// inbox (cloud→daemon invalidate), outbox worker (cloud upload).

export * from './types.js';
export * from './envelope.js';
export { MemoryStore } from './store.js';
export type { MemoryStoreOptions } from './store.js';
export { MemorySearch } from './search.js';
export { MemoryOutbox } from './outbox.js';
export type { MemoryOutboxOptions, EnqueueResult } from './outbox.js';
export { sealPlaintext, unsealPayload } from './crypto.js';
// memory202 doc 06 — at-rest encryption (MVP, flag-gated FF_MEMORY_ENCRYPTION_ENABLED).
export { encrypt, decrypt, isPackedCiphertext, MEMORY_KEY_BYTES } from './crypto-cipher.js';
export { MemoryKeyManager, isEphemeralStorage } from './key-manager.js';
export type { MemoryKeyManagerOptions } from './key-manager.js';
export { MemoryRuntime } from './runtime.js';
export type { MemoryRuntimeOptions } from './runtime.js';
export { attachMemoryRpc } from './rpc.js';
export type { AttachMemoryRpcOptions } from './rpc.js';
// memory203 doc 08 — P0 security spine: per-agent scoped capability tokens.
export { mintCap, mintSystemCap, systemCap, verifyCap, capAllowsWorkspace, isSystemCap } from './cap.js';
export type { MemoryCap, MintCapOptions } from './cap.js';
