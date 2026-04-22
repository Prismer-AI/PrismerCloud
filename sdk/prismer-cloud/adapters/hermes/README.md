# prismer-adapter-hermes

Prismer PARA (Prismer Agent Runtime ABI) adapter for [Hermes](https://hermes-agent.nousresearch.com/) agents by NousResearch.

This is the first Python adapter in the Prismer SDK family.

## What It Does

Translates all 14 Hermes hook events to PARA v0.1 event format and writes them
to `~/.prismer/para/events.jsonl`. The Prismer PARA runtime daemon reads this
file to power the Evolution engine, mobile dashboards, and cross-agent memory.

## Install

```bash
pip install prismer-adapter-hermes
```

Zero runtime dependencies — the wire types are vendored as pure dataclasses.

## Basic Usage

In your Hermes plugin configuration, set the plugin module to
`prismer_adapter_hermes.register`.  Hermes calls `register(ctx)` automatically
on plugin load.

```python
# hermes_plugin.py — your Hermes plugin file
from prismer_adapter_hermes import register

# Hermes calls this at startup
def setup(ctx):
    register(ctx)
```

Or call it directly with a custom sink:

```python
from prismer_adapter_hermes import register, default_jsonl_sink

def setup(ctx):
    adapter = register(ctx, sink=default_jsonl_sink)
    # adapter is a HermesParaAdapter instance
```

## 14 Hook Mappings (§4.6.2)

| Hermes Hook       | PARA Event                | Notes                                    |
|-------------------|---------------------------|------------------------------------------|
| `gateway:startup` | `agent.register`          | L1 Discovery — emits AgentDescriptor    |
| `session:start`   | `agent.session.started`   | Deduped with `on_session_start`          |
| `session:end`     | `agent.session.ended`     | Deduped with `on_session_end`            |
| `session:reset`   | `agent.session.reset`     |                                          |
| `agent:start`     | `agent.prompt.submit`     | source mapped from platform context      |
| `agent:step`      | `agent.turn.step`         | Per tool-loop iteration                  |
| `agent:end`       | `agent.turn.end`          |                                          |
| `command:*`       | `agent.command`           | Wildcard; commandKind normalized         |
| `pre_tool_call`   | `agent.tool.pre`          |                                          |
| `post_tool_call`  | `agent.tool.post` or `agent.tool.failure` | Split on result.success |
| **`pre_llm_call`**| **`agent.llm.pre`**       | **Cache-safe inject — see below**        |
| `post_llm_call`   | `agent.llm.post`          |                                          |
| `on_session_start`| `agent.session.started`   | Alias — deduped, only one emit per session |
| `on_session_end`  | `agent.session.ended`     | Alias — deduped                          |

## pre_llm_call — Cache-Safe Context Injection (P11 Pattern)

`pre_llm_call` is Hermes's standout capability and PARA's P11 Pattern.  The
adapter's `on_pre_llm_call` method accepts an `additional_context` parameter
and returns `{"context": additional_context}`.

Hermes injects this `context` string **into the tail of the current user message**
— not into the system prompt.  This preserves the prompt cache across turns
because the system prompt block never changes.

```python
# Hermes calls your handler like:
#   result = handler(ctx)
# If result["context"] is non-empty, Hermes appends it to the current user message.

# The adapter does this automatically when additional_context is provided:
adapter.on_pre_llm_call(ctx, additional_context="[prismer memory hint: ...]")
# → emits agent.llm.pre PARA event
# → returns {"context": "[prismer memory hint: ...]"}
```

## Observability

Events are appended to `~/.prismer/para/events.jsonl` (one JSON object per line).
Set `PRISMER_PARA_STDOUT=1` to also print events to stdout (useful in dev).

```bash
PRISMER_PARA_STDOUT=1 python -m hermes_agent run
```

## Links

- [PARA Spec §4.6.2](docs/version190/03-para-spec.md) — Hermes 14 hook mappings
- [Prismer Cloud](https://prismer.cloud)
- [Hermes Agent](https://hermes-agent.nousresearch.com/)
