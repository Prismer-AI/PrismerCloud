# @prismer/wire

Canonical wire protocol schemas for the Prismer Agent Runtime ABI (PARA) v0.1.

Single source of truth for all PARA events. Language bindings (Swift, Python) are **generated** from this package — never redefine them elsewhere.

> **Contributors:** `@prismer/sandbox-runtime` resolves from the npm registry. `npm install` in this dir fails until that package is published — use `sdk/build/pack.sh --scope all` + `install.sh --local-artifacts` for local dev.

## Install

```bash
npm install @prismer/wire zod
```

## Key exports

```ts
import { ParaEventSchema, ParaEvent } from '@prismer/wire';
import { encodeFrame, decodeFrame, Opcode } from '@prismer/wire';
import { EncryptedEnvelopeSchema } from '@prismer/wire';
import { parseDeeplink, serializeDeeplink } from '@prismer/wire';

// Permissions (canonical path for @prismer/sandbox-runtime)
import { PermissionRuleSchema, PermissionMode } from '@prismer/wire/permissions';
```

## Event families

| Family | Count | Example events |
|---|---|---|
| Lifecycle | 8 | `agent.register`, `agent.session.started` |
| Turn / LLM | 6 | `agent.llm.pre`, `agent.turn.end` |
| Message I/O | 5 | `agent.channel.inbound`, `agent.message` |
| Tool | 5 | `agent.tool.pre`, `agent.elicitation.request` |
| Permission | 3 | `agent.approval.request`, `agent.approval.denied` |
| Task / Teammate / Cmd | 4 | `agent.task.created`, `agent.command` |
| Memory / Context | 4 | `agent.compact.pre`, `agent.bootstrap.injected` |
| Environment | 6 | `agent.fs.op`, `agent.cwd.changed` |
| Notification | 1 | `agent.notification` |
| Skill | 5 | `agent.skill.activated`, `agent.skill.proposed` |

## Codegen (Swift + Python)

```bash
npm run build    # builds dist/
npm run codegen  # generates dist/wire.schema.json, dist/PrismerWireDTO.swift, dist/prismer_wire.py
```

The Swift DTO is consumed by lumin-swift. The Python file is consumed by `prismer-adapter-hermes`.
Per D15: quicktype emits a flat struct with all fields optional — the type-safe enum wrapper is the consumer's responsibility.

## Binary frame

2-byte overhead (opcode + slot). Designed for WS multiplexing per EXP-06 (5M enc/s).

```ts
const encoded = encodeFrame({ opcode: Opcode.JSON_CONTROL, slot: 0, payload });
const { opcode, slot, payload } = decodeFrame(encoded);
```
