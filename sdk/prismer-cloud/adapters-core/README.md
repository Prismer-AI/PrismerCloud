# @prismer/adapters-core

Shared utilities for Prismer PARA adapters. Consumed by:
- `@prismer/claude-code-plugin` (CC adapter, Task 3)
- `@prismer/openclaw-channel` (OpenClaw adapter, Task 4)

**NOT published for external use** — internal shared code to eliminate duplication between the two TS adapters.

> **Contributors:** `@prismer/wire` resolves from the npm registry. `npm install` in this dir fails until `@prismer/wire` is published — use `sdk/build/pack.sh --scope all` + `install.sh --local-artifacts` for local dev.

## Key Exports

### `PermissionLeaseManager`
Tracks which skills own which `PermissionRule`s. When a skill deactivates (`agent.skill.deactivated`), call `revoke(skillName)` to atomically remove its rules.

```ts
const leases = new PermissionLeaseManager();
leases.grant('review', [{ source: 'skill', behavior: 'allow', value: 'Read' }]);
leases.active();           // flat list of all leased rules
leases.revoke('review');   // returns the revoked rules
leases.clear();            // remove all
```

### Event builders (`event-builder.ts`)
Pure constructors for the ~20 PARA events adapters commonly emit. Each validates via `ParaEventSchema.parse()` and throws `ZodError` on bad input.

```ts
import { makeToolPre, makeSessionStarted, makeRegisterEvent } from '@prismer/adapters-core';

const evt = makeToolPre({ callId: 'c1', tool: 'Bash', args: 'ls', riskTag: 'low' });
```

### Normalizers (`normalize.ts`)
Coerce raw hook payloads into canonical types:

```ts
normalizeCallId(raw)               // UUIDv4 if absent
normalizeTimestamp(raw)            // ms epoch; accepts Date | ISO string | number
normalizeSessionId(raw, fallback?) // string; generates if absent
normalizeRiskTag(toolName, args)   // 'low' | 'mid' | 'high' heuristic
```

### `EventDispatcher`
Routes validated PARA events to a transport sink. Validation failures invoke `onError` instead of throwing.

```ts
const dispatcher = new EventDispatcher((evt) => process.stdout.write(JSON.stringify(evt) + '\n'));
dispatcher.onError((err, evt) => console.error('[dispatcher] drop:', err.message));
await dispatcher.emit(evt);
```

## Dependency Strategy
`@prismer/wire` is resolved via a local tarball (`../wire/prismer-wire-0.1.0.tgz`) because `@prismer/wire@0.1.0` is not yet published to npm. Per project memory (`feedback_npm_file_dep_silent_fail.md`), `file:` path deps are avoided to prevent dangling symlinks at publish time; tarball deps are safe.
