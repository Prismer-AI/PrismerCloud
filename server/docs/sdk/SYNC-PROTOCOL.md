# Evolution Sync Protocol — SDK <-> Cloud

**Version:** 1.0
**Date:** 2026-03-22
**Status:** Implemented (TypeScript SDK v1.7.2+)

## Overview

The sync protocol enables SDK-side local evolution runtime by maintaining a local gene cache and asynchronous outcome reporting. All gene selection happens locally (<1ms), while outcomes are queued in a Write-Ahead Log (WAL) and batch-flushed to the cloud.

## Architecture

```
Agent --- SDK (Local Evolution Runtime) === async sync === Cloud
          |                                                  |
          +-- Gene Cache (read-optimized)                   +-- Gene DB (source of truth)
          +-- Edge Snapshot (alpha/beta local copy)          +-- Edge aggregation
          +-- Outcome Outbox (write-ahead log)               +-- Capsule storage
          +-- Signal Enrichment (rules/LLM)                  +-- Signal Extractor (LLM)
          +-- selectGene() -- pure CPU                       +-- Pooled Prior computation
```

## Endpoints

### GET /api/evolution/sync/snapshot

Full snapshot for initial cache load.

**Query:** `?since=0` (cursor, 0 = full snapshot)
**Auth:** JWT required

**Response:**
```json
{
  "ok": true,
  "data": {
    "genes": [{ "id": "...", "category": "repair", "..." : "..." }],
    "edges": [{ "signal_key": "error:timeout", "gene_id": "...", "success_count": 5, "failure_count": 1 }],
    "globalPrior": {
      "error:timeout": { "alpha": 23, "beta": 7 },
      "error:connection_refused": { "alpha": 15, "beta": 3 }
    },
    "cursor": 1711100000000
  }
}
```

### POST /api/evolution/sync

Bidirectional sync: push outcomes + pull updates in one HTTP round-trip.

**Auth:** JWT required

**Request:**
```json
{
  "push": {
    "outcomes": [
      { "gene_id": "...", "signals": ["..."], "outcome": "success", "summary": "..." }
    ]
  },
  "pull": {
    "since": 1711100000000
  }
}
```

**Response:**
```json
{
  "ok": true,
  "data": {
    "pushed": { "accepted": 3, "rejected": [] },
    "pulled": {
      "genes": [],
      "edges": [],
      "globalPrior": {},
      "promotions": ["gene-id-1"],
      "quarantines": [],
      "cursor": 1711100060000
    }
  }
}
```

## Edge Merge (CRDT-like)

Alpha/beta counts are commutative additive quantities -- no conflict resolution needed.

```
Local edge:   alpha_local=5, beta_local=2  (own observations)
Cloud delta:  delta_alpha_global=+3, delta_beta_global=+1  (other agents' observations)

selectGene blending:
  blended_alpha = alpha_local + wGlobal * alpha_global
  blended_beta  = beta_local  + wGlobal * beta_global
  (wGlobal = 0.3 default)
```

## SDK Lifecycle

```
1. initialize()        -> GET /evolution/sync/snapshot (full load)
2. selectGene(signals) -> local CPU (<1ms)
3. record(outcome)     -> local WAL (enqueue, returns void)
4. [timer: 30s]        -> POST /evolution/sync (push outcomes + pull delta)
5. close()             -> final flush + stop timers
```

## Outbox Guarantees

- **At-least-once delivery**: outcomes are retried up to 5 times
- **Idempotency**: each operation has a unique idempotency key
- **Durability**: depends on StorageAdapter -- MemoryStorage survives process lifetime; SQLiteStorage survives restarts
- **Ordering**: FIFO within a single SDK instance; cross-instance ordering is not guaranteed (server handles via timestamps)

## Outbox Operation Lifecycle

```
enqueue() -> [pending] -> flush() -> [inflight] -> HTTP POST -> [confirmed] -> remove
                                                       |
                                                   error? -> retries++ -> [pending] (retry)
                                                                            |
                                                                      max_retries? -> [failed] -> remove
```

## Outbox Configuration

| Parameter       | Default | Description                                 |
|-----------------|---------|---------------------------------------------|
| flush_interval  | 1s      | How often the background thread flushes      |
| max_retries     | 5       | Max retry attempts before marking as failed  |
| batch_size      | 10      | Max operations per flush cycle               |

## Cross-SDK Parity

| Feature          | TypeScript | Python  | Go      | Rust     |
|------------------|:----------:|:-------:|:-------:|:--------:|
| Outcome WAL      | StorageAdapter | In-memory deque | In-memory slice | Planned |
| Gene Cache       | EvolutionCache | Planned | Planned | Planned |
| Signal Rules     | 16 patterns | 16 patterns | 16 patterns | Planned |
| LLM Enrichment   | Optional inject | Planned | Planned | Planned |
| Sync Protocol    | push/pull | Planned | Planned | Planned |

## Usage Examples

### TypeScript

```typescript
import { PrismerClient, EvolutionLocalRuntime } from '@prismer/sdk';

const client = new PrismerClient({ apiKey: 'sk-prismer-...' });
const runtime = new EvolutionLocalRuntime(client, { flushInterval: 1000 });
await runtime.initialize();

// Fire-and-forget recording
runtime.record({ geneId: '...', signals: [...], outcome: 'success', summary: '...' });

// On shutdown
await runtime.close();
```

### Python

```python
from prismer import PrismerClient, EvolutionOutbox

client = PrismerClient(api_key="sk-prismer-...")
outbox = EvolutionOutbox(client._im_request, flush_interval=1.0)
outbox.start()

# Configure on EvolutionClient
client.im.evolution.configure_outbox(outbox)

# Fire-and-forget recording
client.im.evolution.record("gene-id", ["error:timeout"], "success", "Fixed timeout")

# On shutdown
outbox.stop()
```

### Go

```go
import prismer "github.com/Prismer-AI/Prismer/sdk/golang"

client := prismer.NewClient("sk-prismer-...")
outbox := prismer.NewEvolutionOutbox(func(ctx context.Context, method, path string, body interface{}) error {
    _, err := client.IM().Evolution.im.do(ctx, method, path, body, nil)
    return err
}, nil)
outbox.Start()

client.IM().Evolution.ConfigureOutbox(outbox)

// Fire-and-forget recording
client.IM().Evolution.Record(ctx, &prismer.RecordOutcomeOptions{
    GeneID:  "gene-id",
    Signals: []any{"error:timeout"},
    Outcome: "success",
    Summary: "Fixed timeout",
})

// On shutdown
outbox.Stop()
```

## Protocol Versioning

The sync protocol version is included in the `X-Prismer-Sync-Version` header. The server must handle backward-compatible changes gracefully. Breaking changes require a new version number and a migration period.

| Version | Date       | Changes                          |
|---------|------------|----------------------------------|
| 1.0     | 2026-03-22 | Initial protocol specification   |
